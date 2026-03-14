import type { AnyAgentTool } from "../../pi-tools.types.js";

export type CliMapper = {
  /**
   * The sub-command structure (e.g., ["feishu", "doc", "update"])
   */
  command: string[];

  /**
   * Translates the raw `--foo bar` args into the JSON schema expected by the original tool.
   */
  parseArgs: (args: string[]) => Record<string, unknown>;

  /**
   * Translates the JSON Schema of the original tool into a beautifully formatted Bash --help text.
   */
  generateHelp: (toolDef: AnyAgentTool) => string;
};

/**
 * A basic generic parser that simply maps `--key value` into JSON.
 * Perfect for flat schemas.
 */
export function defaultGenericParser(args: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg && arg.startsWith("--")) {
      const key = arg.slice(2);
      if (i + 1 < args.length && !args[i + 1]?.startsWith("--")) {
        const val = args[i + 1];
        if (val === "true") {
          params[key] = true;
        } else if (val === "false") {
          params[key] = false;
        } else if (!Number.isNaN(Number(val)) && val?.trim() !== "") {
          params[key] = Number(val);
        } else {
          params[key] = val;
        }
        i++;
      } else {
        params[key] = true;
      }
    }
  }
  return params;
}

/**
 * A generic help generator that reads the tool's JSON schema and outputs Bash style docs.
 */
export function defaultGenericHelp(tool: AnyAgentTool, cliCommand: string): string {
  const schema = tool.parameters as Record<string, unknown> | undefined;
  let help = `Usage: openclaw-tool ${cliCommand} [options]\n\n`;
  help += `${tool.description || "No description provided."}\n\n`;

  if (schema && schema.properties) {
    help += `Options:\n`;
    const props = schema.properties as Record<string, unknown>;
    const requiredArr = Array.isArray(schema.required) ? schema.required : [];

    for (const [key, prop] of Object.entries(props)) {
      const isRequired = requiredArr.includes(key);
      const reqText = isRequired ? "(required)" : "(optional)";
      const p = prop as Record<string, unknown>;
      const pType = typeof p.type === "string" ? p.type : "string";
      const pDesc = typeof p.description === "string" ? p.description : "No description";
      help += `  --${key} <${pType}>\n`;
      help += `      ${pDesc} ${reqText}\n`;
    }
  } else {
    help += `No parameters required.\n`;
  }

  return help;
}
