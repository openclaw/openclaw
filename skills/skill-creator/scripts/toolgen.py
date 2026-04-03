#!/usr/bin/env python3
"""
Tool Template Generator for OpenClaw skills
"""

import argparse
import sys
from pathlib import Path

ALLOWED_TYPES = {"bash", "python", "node"}

def generate_bash(tool_name, description, arguments):
    options = []
    positional = []
    for arg in arguments:
        if arg['flag'].startswith('-'):
            options.append(arg)
        else:
            positional.append(arg)

    lines = [f'''#!/usr/bin/env bash
# Tool: {tool_name}
# Description: {description}

set -euo pipefail

# Defaults''']
    for opt in options:
        # Sanitize flag name: replace hyphens with underscores for valid bash variable
        name = opt['flag'].lstrip('-').replace('-', '_')
        default = opt.get('default', '')
        lines.append(f"{name}=\"{default}\"")
    lines.append("")

    if options:
        lines.append("while [[ $# -gt 0 ]]; do")
        lines.append("    case $1 in")
        for opt in options:
            flag = opt['flag']
            name = flag.lstrip('-').replace('-', '_')
            # Only emit option itself (no duplicate), since short aliases not supported
            lines.append(f"        {flag})")
            # Boolean flags don't consume a value; others do
            if opt.get('type') == 'bool':
                lines.append(f"            {name}=true; shift 1;;")
            else:
                lines.append(f"            {name}=\"$2\"; shift 2;;")
        lines.append("        *) break;;")
        lines.append("    esac")
        lines.append("done\n")

    for i, pos in enumerate(positional):
        name = pos.get('name', f"arg{i}")
        lines.append(f"if [ $# -lt {i+1} ]; then")
        lines.append(f"    echo 'Error: missing positional: {name}' >&2")
        lines.append("    exit 1")
        lines.append(f"fi")
        lines.append(f"{name}=${{1}}")
        lines.append("shift")
        lines.append("")

    lines.append(f'''# TODO: Implement tool logic
echo "Running {tool_name}"
# Access variables:''')
    for opt in options:
        name = opt['flag'].lstrip('-').replace('-', '_')
        lines.append(f"#   ${name}: ${name}")
    for pos in positional:
        name = pos.get('name', 'arg')
        lines.append(f"#   {name}: ${name}")
    lines.append("")
    return "\n".join(lines)

def generate_python(tool_name, description, arguments):
    arg_lines = []
    extract_lines = []
    validation_lines = []

    for arg in arguments:
        flag = arg['flag']
        name = arg.get('name', flag.lstrip('-').replace('-', '_'))
        arg_type = arg.get('type', 'str')
        help_text = arg.get('help', '')

        if flag.startswith('--'):
            # optional flag
            if arg_type == 'bool':
                line = f"parser.add_argument('{flag}', action='store_true', help='{help_text}')"
            else:
                line = f"parser.add_argument('{flag}', type={arg_type}, help='{help_text}')"
            arg_lines.append(line)
            extract_lines.append(f"{name} = args.{name}")
        else:
            # positional argument
            arg_lines.append(f"parser.add_argument('{name}', type={arg_type}, help='{help_text}')")
            extract_lines.append(f"{name} = args.{name}")

    arg_code = "\\n    ".join(arg_lines)
    extract_code = "\\n    ".join(extract_lines)

    arg_code = "\n    ".join(arg_lines)
    extract_code = "\n    ".join(extract_lines)
    # We currently have no automatic validation

    content = f'''#!/usr/bin/env python3
"""
Tool: {tool_name}
Description: {description}
"""

import argparse
import sys

def main():
    parser = argparse.ArgumentParser(
        description="{description}",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  {tool_name} --input file.txt --output out.txt
  {tool_name} --verbose
        """
    )
    {arg_code}

    args = parser.parse_args()

    # TODO: implement your tool logic here
    {extract_code}

    print("Running {tool_name} with:", args)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\\nInterrupted", file=sys.stderr)
        sys.exit(130)
    except Exception as e:
        print(f"Error: {{e}}", file=sys.stderr)
        sys.exit(1)
'''
    return content

def generate_node(tool_name, description, arguments):
    options = []
    for arg in arguments:
        if arg['flag'].startswith('-'):
            name = arg.get('name', arg['flag'].lstrip('-').replace('-', '_'))
            opt_type = arg.get('type', 'string')
            options.append(f"    '{name}': {{ type: '{opt_type}' }}")

    # opts_str computed but not used - removed

    content = f'''#!/usr/bin/env node
/**
 * Tool: {tool_name}
 * Description: {description}
 */

// Simple argument parsing without external deps
const args = {};
// Parse flags
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--')) {
    const parts = arg.slice(2).split(':');
    const key = parts[0];
    if (parts.length > 1) {
      // Has type hint, ignore for now; store raw
      args[key] = process.argv[i+1] || true;
      i++; // consume value
    } else {
      args[key] = true;
    }
  }
}

// TODO: implement
console.log('Running {tool_name} with args:', args);
'''
    return content

def main():
    parser = argparse.ArgumentParser(description="Generate tool scripts")
    parser.add_argument("tool_name")
    parser.add_argument("--type", choices=ALLOWED_TYPES, required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--description", default="")
    parser.add_argument("--args", default="")
    ns = parser.parse_args()

    tool_name = ns.tool_name.lower()
    output_dir = Path(ns.output)
    output_dir.mkdir(parents=True, exist_ok=True)

    arguments = []
    if ns.args:
        for arg_str in ns.args.split(','):
            parts = [p.strip() for p in arg_str.split(':')]
            if not parts:
                continue
            flag = parts[0]
            arg_def = {'flag': flag}
            if len(parts) > 1:
                arg_def['type'] = parts[1]
            if len(parts) > 2:
                arg_def['help'] = parts[2]
            arguments.append(arg_def)

    if ns.type == "bash":
        ext = "sh"
        content = generate_bash(tool_name, ns.description, arguments)
    elif ns.type == "python":
        ext = "py"
        content = generate_python(tool_name, ns.description, arguments)
    elif ns.type == "node":
        ext = "js"
        content = generate_node(tool_name, ns.description, arguments)
    else:
        parser.error("invalid type")

    out_file = output_dir / f"{tool_name}.{ext}"
    out_file.write_text(content)
    out_file.chmod(0o755)
    print(f"✅ Generated: {out_file}")

if __name__ == "__main__":
    main()
