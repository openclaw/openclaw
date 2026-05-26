import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { a as routeLogsToStderr } from "./console-BAPPAj56.js";
import { a as installCompletion, c as resolveCompletionCachePath, s as isCompletionShell, t as COMPLETION_SHELLS, u as resolveShellFromEnv } from "./completion-runtime-Bk_B9fm2.js";
import { n as registerSubCliByName, t as getSubCliEntries } from "./register.subclis-core-DIt_Jj2Q.js";
import { n as registerCoreCliByName, t as getCoreCliCommandNames } from "./command-registry-core-CbkSlXMT.js";
import { t as getProgramContext } from "./program-context-CFLHovaZ.js";
import path from "node:path";
import fs from "node:fs/promises";
import { Option } from "commander";
//#region src/cli/completion-fish.ts
function escapeFishDescription(value) {
	return value.replace(/'/g, "'\\''");
}
function parseOptionFlags(flags) {
	const parts = flags.split(/[ ,|]+/);
	return {
		long: parts.find((flag) => flag.startsWith("--"))?.replace(/^--/, ""),
		short: parts.find((flag) => flag.startsWith("-") && !flag.startsWith("--"))?.replace(/^-/, "")
	};
}
function buildFishSubcommandCompletionLine(params) {
	const desc = escapeFishDescription(params.description);
	return `complete -c ${params.rootCmd} -n "${params.condition}" -a "${params.name}" -d '${desc}'\n`;
}
function buildFishOptionCompletionLine(params) {
	const { short, long } = parseOptionFlags(params.flags);
	const desc = escapeFishDescription(params.description);
	let line = `complete -c ${params.rootCmd} -n "${params.condition}"`;
	if (short) line += ` -s ${short}`;
	if (long) line += ` -l ${long}`;
	line += ` -d '${desc}'\n`;
	return line;
}
//#endregion
//#region src/cli/completion-cli.ts
function getCompletionScript(shell, program) {
	if (shell === "zsh") return generateZshCompletion(program);
	if (shell === "bash") return generateBashCompletion(program);
	if (shell === "powershell") return generatePowerShellCompletion(program);
	return generateFishCompletion(program);
}
async function writeCompletionCache(params) {
	const firstShell = params.shells[0] ?? "zsh";
	const cacheDir = path.dirname(resolveCompletionCachePath(firstShell, params.binName));
	await fs.mkdir(cacheDir, { recursive: true });
	for (const shell of params.shells) {
		const script = getCompletionScript(shell, params.program);
		const targetPath = resolveCompletionCachePath(shell, params.binName);
		await fs.writeFile(targetPath, script, "utf-8");
	}
}
function writeCompletionRegistrationWarning(message) {
	process.stderr.write(`[completion] ${message}\n`);
}
async function registerSubcommandsForCompletion(program) {
	const entries = getSubCliEntries();
	for (const entry of entries) {
		if (entry.name === "completion") continue;
		try {
			await registerSubCliByName(program, entry.name, process.argv, { purpose: "completion" });
		} catch (error) {
			writeCompletionRegistrationWarning(`skipping subcommand \`${entry.name}\` while building completion cache: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}
function registerCompletionCli(program) {
	program.command("completion").description("Generate shell completion script").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/completion", "docs.openclaw.ai/cli/completion")}\n`).addOption(new Option("-s, --shell <shell>", "Shell to generate completion for (default: zsh)").choices(COMPLETION_SHELLS)).option("-i, --install", "Install completion script to shell profile").option("--write-state", "Write completion scripts to $OPENCLAW_STATE_DIR/completions (no stdout)").option("-y, --yes", "Skip confirmation (non-interactive)", false).action(async (options) => {
		routeLogsToStderr();
		const shell = options.shell ?? "zsh";
		const ctx = getProgramContext(program);
		if (ctx) for (const name of getCoreCliCommandNames()) await registerCoreCliByName(program, ctx, name);
		await registerSubcommandsForCompletion(program);
		if (process.env["OPENCLAW_COMPLETION_SKIP_PLUGIN_COMMANDS"] !== "1") {
			const { registerPluginCliCommandsFromValidatedConfig } = await import("./cli-BsRJL3n0.js");
			await registerPluginCliCommandsFromValidatedConfig(program, void 0, void 0, { mode: "eager" });
		}
		if (options.writeState) await writeCompletionCache({
			program,
			shells: options.shell ? [shell] : [...COMPLETION_SHELLS],
			binName: program.name()
		});
		if (options.install) {
			await installCompletion(options.shell ?? resolveShellFromEnv(), Boolean(options.yes), program.name());
			return;
		}
		if (options.writeState) return;
		if (!isCompletionShell(shell)) throw new Error(`Unsupported shell: ${shell}`);
		const script = getCompletionScript(shell, program);
		process.stdout.write(script + "\n");
	});
}
function generateZshCompletion(program) {
	const rootCmd = program.name();
	return `
#compdef ${rootCmd}

_${rootCmd}_root_completion() {
  local -a commands
  local -a options
  
  _arguments -C \\
    ${generateZshArgs(program)} \\
    ${generateZshSubcmdList(program)} \\
    "*::arg:->args"

  case $state in
    (args)
      case $line[1] in
        ${program.commands.map((cmd) => `(${cmd.name()}) _${rootCmd}_${cmd.name().replace(/-/g, "_")} ;;`).join("\n        ")}
      esac
      ;;
  esac
}

${generateZshSubcommands(program, rootCmd)}

_${rootCmd}_register_completion() {
  if (( ! $+functions[compdef] )); then
    return 0
  fi

  compdef _${rootCmd}_root_completion ${rootCmd}
  precmd_functions=(\${precmd_functions:#_${rootCmd}_register_completion})
  unfunction _${rootCmd}_register_completion 2>/dev/null
}

_${rootCmd}_register_completion
if (( ! $+functions[compdef] )); then
  typeset -ga precmd_functions
  if [[ -z "\${precmd_functions[(r)_${rootCmd}_register_completion]}" ]]; then
    precmd_functions+=(_${rootCmd}_register_completion)
  fi
fi
`;
}
function generateZshArgs(cmd) {
	return (cmd.options || []).map((opt) => {
		const flags = opt.flags.split(/[ ,|]+/);
		const name = flags.find((f) => f.startsWith("--")) || flags[0];
		const short = flags.find((f) => f.startsWith("-") && !f.startsWith("--"));
		const desc = opt.description.replace(/\\/g, "\\\\").replace(/"/g, "\\\"").replace(/'/g, "'\\''").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
		if (short) return `"(${name} ${short})"{${name},${short}}"[${desc}]"`;
		return `"${name}[${desc}]"`;
	}).join(" \\\n    ");
}
function generateZshSubcmdList(cmd) {
	return `"1: :_values 'command' ${cmd.commands.map((c) => {
		const desc = c.description().replace(/\\/g, "\\\\").replace(/'/g, "'\\''").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
		return `'${c.name()}[${desc}]'`;
	}).join(" ")}"`;
}
function generateZshSubcommands(program, prefix) {
	const segments = [];
	const visit = (current, currentPrefix) => {
		for (const cmd of current.commands) {
			const nextPrefix = `${currentPrefix}_${cmd.name().replace(/-/g, "_")}`;
			const funcName = `_${nextPrefix}`;
			visit(cmd, nextPrefix);
			const subCommands = cmd.commands;
			if (subCommands.length > 0) {
				segments.push(`
${funcName}() {
  local -a commands
  local -a options
  
  _arguments -C \\
    ${generateZshArgs(cmd)} \\
    ${generateZshSubcmdList(cmd)} \\
    "*::arg:->args"

  case $state in
    (args)
      case $line[1] in
        ${subCommands.map((sub) => `(${sub.name()}) ${funcName}_${sub.name().replace(/-/g, "_")} ;;`).join("\n        ")}
      esac
      ;;
  esac
}
`);
				continue;
			}
			segments.push(`
${funcName}() {
  _arguments -C \\
    ${generateZshArgs(cmd)}
}
`);
		}
	};
	visit(program, prefix);
	return segments.join("");
}
function generateBashCompletion(program) {
	const rootCmd = program.name();
	return `
_${rootCmd}_completion() {
    local cur prev opts
    COMPREPLY=()
    cur="\${COMP_WORDS[COMP_CWORD]}"
    prev="\${COMP_WORDS[COMP_CWORD-1]}"
    
    # Simple top-level completion for now
    opts="${program.commands.map((c) => c.name()).join(" ")} ${program.options.map((o) => o.flags.split(" ")[0]).join(" ")}"
    
    case "\${prev}" in
      ${program.commands.map((cmd) => generateBashSubcommand(cmd)).join("\n      ")}
    esac

    if [[ \${cur} == -* ]] ; then
        COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
        return 0
    fi
    
    COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
}

complete -F _${rootCmd}_completion ${rootCmd}
`;
}
function generateBashSubcommand(cmd) {
	return `${cmd.name()})
        opts="${cmd.commands.map((c) => c.name()).join(" ")} ${cmd.options.map((o) => o.flags.split(" ")[0]).join(" ")}"
        COMPREPLY=( $(compgen -W "\${opts}" -- \${cur}) )
        return 0
        ;;`;
}
function generatePowerShellCompletion(program) {
	const rootCmd = program.name();
	const segments = [];
	const visit = (cmd, pathSegments) => {
		const fullPath = pathSegments.join(" ");
		const subCommands = cmd.commands.map((c) => c.name());
		const options = cmd.options.map((o) => o.flags.split(/[ ,|]+/)[0]);
		const allCompletions = [...subCommands, ...options].map((s) => `'${s}'`).join(",");
		if (fullPath.length > 0 && allCompletions.length > 0) segments.push(`
            if ($commandPath -eq '${fullPath}') {
                $completions = @(${allCompletions})
                $completions | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_)
                }
            }
`);
		for (const sub of cmd.commands) visit(sub, [...pathSegments, sub.name()]);
	};
	visit(program, []);
	const rootBody = segments.join("");
	return `
Register-ArgumentCompleter -Native -CommandName ${rootCmd} -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    
    $commandElements = $commandAst.CommandElements
    $commandPath = ""
    
    # Reconstruct command path (simple approximation)
    # Skip the executable name
    for ($i = 1; $i -lt $commandElements.Count; $i++) {
        $element = $commandElements[$i].Extent.Text
        if ($element -like "-*") { break }
        if ($i -eq $commandElements.Count - 1 -and $wordToComplete -ne "") { break } # Don't include current word being typed
        $commandPath += "$element "
    }
    $commandPath = $commandPath.Trim()
    
    # Root command
    if ($commandPath -eq "") {
         $completions = @(${program.commands.map((c) => `'${c.name()}'`).join(",")}, ${program.options.map((o) => `'${o.flags.split(" ")[0]}'`).join(",")}) 
         $completions | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_)
         }
    }
    
    ${rootBody}
}
`;
}
function generateFishCompletion(program) {
	const rootCmd = program.name();
	const segments = [];
	const visit = (cmd, parents) => {
		const cmdName = cmd.name();
		if (parents.length === 0) {
			for (const sub of cmd.commands) segments.push(buildFishSubcommandCompletionLine({
				rootCmd,
				condition: "__fish_use_subcommand",
				name: sub.name(),
				description: sub.description()
			}));
			for (const opt of cmd.options) segments.push(buildFishOptionCompletionLine({
				rootCmd,
				condition: "__fish_use_subcommand",
				flags: opt.flags,
				description: opt.description
			}));
		} else {
			for (const sub of cmd.commands) segments.push(buildFishSubcommandCompletionLine({
				rootCmd,
				condition: `__fish_seen_subcommand_from ${cmdName}`,
				name: sub.name(),
				description: sub.description()
			}));
			for (const opt of cmd.options) segments.push(buildFishOptionCompletionLine({
				rootCmd,
				condition: `__fish_seen_subcommand_from ${cmdName}`,
				flags: opt.flags,
				description: opt.description
			}));
		}
		for (const sub of cmd.commands) visit(sub, [...parents, cmdName]);
	};
	visit(program, []);
	return segments.join("");
}
//#endregion
export { getCompletionScript, registerCompletionCli };
