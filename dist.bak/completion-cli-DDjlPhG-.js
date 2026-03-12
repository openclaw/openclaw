import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { g as resolveStateDir } from "./paths-B4BZAPZh.js";
import { B as theme, h as pathExists } from "./utils-BKDT474X.js";
import { i as routeLogsToStderr } from "./subsystem-LTWJBEIv.js";
import { t as formatDocsLink } from "./links-_OmPhBsv.js";
import { a as registerCoreCliByName, c as getSubCliEntries, l as registerSubCliByName, r as getCoreCliCommandNames, t as getProgramContext } from "./program-context-Q3trwEVO.js";
import os from "node:os";
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
var completion_cli_exports = /* @__PURE__ */ __exportAll({
	completionCacheExists: () => completionCacheExists,
	installCompletion: () => installCompletion,
	isCompletionInstalled: () => isCompletionInstalled,
	registerCompletionCli: () => registerCompletionCli,
	resolveCompletionCachePath: () => resolveCompletionCachePath,
	resolveShellFromEnv: () => resolveShellFromEnv,
	usesSlowDynamicCompletion: () => usesSlowDynamicCompletion
});
const COMPLETION_SHELLS = [
	"zsh",
	"bash",
	"powershell",
	"fish"
];
function isCompletionShell(value) {
	return COMPLETION_SHELLS.includes(value);
}
function resolveShellFromEnv(env = process.env) {
	const shellPath = env.SHELL?.trim() ?? "";
	const shellName = shellPath ? path.basename(shellPath).toLowerCase() : "";
	if (shellName === "zsh") return "zsh";
	if (shellName === "bash") return "bash";
	if (shellName === "fish") return "fish";
	if (shellName === "pwsh" || shellName === "powershell") return "powershell";
	return "zsh";
}
function sanitizeCompletionBasename(value) {
	const trimmed = value.trim();
	if (!trimmed) return "openclaw";
	return trimmed.replace(/[^a-zA-Z0-9._-]/g, "-");
}
function resolveCompletionCacheDir(env = process.env) {
	const stateDir = resolveStateDir(env, os.homedir);
	return path.join(stateDir, "completions");
}
function resolveCompletionCachePath(shell, binName) {
	const basename = sanitizeCompletionBasename(binName);
	const extension = shell === "powershell" ? "ps1" : shell === "fish" ? "fish" : shell === "bash" ? "bash" : "zsh";
	return path.join(resolveCompletionCacheDir(), `${basename}.${extension}`);
}
/** Check if the completion cache file exists for the given shell. */
async function completionCacheExists(shell, binName = "openclaw") {
	return pathExists(resolveCompletionCachePath(shell, binName));
}
function getCompletionScript(shell, program) {
	if (shell === "zsh") return generateZshCompletion(program);
	if (shell === "bash") return generateBashCompletion(program);
	if (shell === "powershell") return generatePowerShellCompletion(program);
	return generateFishCompletion(program);
}
async function writeCompletionCache(params) {
	const cacheDir = resolveCompletionCacheDir();
	await fs.mkdir(cacheDir, { recursive: true });
	for (const shell of params.shells) {
		const script = getCompletionScript(shell, params.program);
		const targetPath = resolveCompletionCachePath(shell, params.binName);
		await fs.writeFile(targetPath, script, "utf-8");
	}
}
function formatCompletionSourceLine(shell, binName, cachePath) {
	if (shell === "fish") return `source "${cachePath}"`;
	return `source "${cachePath}"`;
}
function isCompletionProfileHeader(line) {
	return line.trim() === "# OpenClaw Completion";
}
function isCompletionProfileLine(line, binName, cachePath) {
	if (line.includes(`${binName} completion`)) return true;
	if (cachePath && line.includes(cachePath)) return true;
	return false;
}
/** Check if a line uses the slow dynamic completion pattern (source <(...)) */
function isSlowDynamicCompletionLine(line, binName) {
	return line.includes(`<(${binName} completion`) || line.includes(`${binName} completion`) && line.includes("| source");
}
function updateCompletionProfile(content, binName, cachePath, sourceLine) {
	const lines = content.split("\n");
	const filtered = [];
	let hadExisting = false;
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i] ?? "";
		if (isCompletionProfileHeader(line)) {
			hadExisting = true;
			i += 1;
			continue;
		}
		if (isCompletionProfileLine(line, binName, cachePath)) {
			hadExisting = true;
			continue;
		}
		filtered.push(line);
	}
	const trimmed = filtered.join("\n").trimEnd();
	const block = `# OpenClaw Completion\n${sourceLine}`;
	const next = trimmed ? `${trimmed}\n\n${block}\n` : `${block}\n`;
	return {
		next,
		changed: next !== content,
		hadExisting
	};
}
function getShellProfilePath(shell) {
	const home = process.env.HOME || os.homedir();
	if (shell === "zsh") return path.join(home, ".zshrc");
	if (shell === "bash") return path.join(home, ".bashrc");
	if (shell === "fish") return path.join(home, ".config", "fish", "config.fish");
	if (process.platform === "win32") return path.join(process.env.USERPROFILE || home, "Documents", "PowerShell", "Microsoft.PowerShell_profile.ps1");
	return path.join(home, ".config", "powershell", "Microsoft.PowerShell_profile.ps1");
}
async function isCompletionInstalled(shell, binName = "openclaw") {
	const profilePath = getShellProfilePath(shell);
	if (!await pathExists(profilePath)) return false;
	const cachePathCandidate = resolveCompletionCachePath(shell, binName);
	const cachedPath = await pathExists(cachePathCandidate) ? cachePathCandidate : null;
	return (await fs.readFile(profilePath, "utf-8")).split("\n").some((line) => isCompletionProfileHeader(line) || isCompletionProfileLine(line, binName, cachedPath));
}
/**
* Check if the profile uses the slow dynamic completion pattern.
* Returns true if profile has `source <(openclaw completion ...)` instead of cached file.
*/
async function usesSlowDynamicCompletion(shell, binName = "openclaw") {
	const profilePath = getShellProfilePath(shell);
	if (!await pathExists(profilePath)) return false;
	const cachePath = resolveCompletionCachePath(shell, binName);
	const lines = (await fs.readFile(profilePath, "utf-8")).split("\n");
	for (const line of lines) if (isSlowDynamicCompletionLine(line, binName) && !line.includes(cachePath)) return true;
	return false;
}
function registerCompletionCli(program) {
	program.command("completion").description("Generate shell completion script").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/completion", "docs.openclaw.ai/cli/completion")}\n`).addOption(new Option("-s, --shell <shell>", "Shell to generate completion for (default: zsh)").choices(COMPLETION_SHELLS)).option("-i, --install", "Install completion script to shell profile").option("--write-state", "Write completion scripts to $OPENCLAW_STATE_DIR/completions (no stdout)").option("-y, --yes", "Skip confirmation (non-interactive)", false).action(async (options) => {
		routeLogsToStderr();
		const shell = options.shell ?? "zsh";
		const ctx = getProgramContext(program);
		if (ctx) for (const name of getCoreCliCommandNames()) await registerCoreCliByName(program, ctx, name);
		const entries = getSubCliEntries();
		for (const entry of entries) {
			if (entry.name === "completion") continue;
			await registerSubCliByName(program, entry.name);
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
async function installCompletion(shell, yes, binName = "openclaw") {
	const home = process.env.HOME || os.homedir();
	let profilePath = "";
	let sourceLine = "";
	if (!isCompletionShell(shell)) {
		console.error(`Automated installation not supported for ${shell} yet.`);
		return;
	}
	const cachePath = resolveCompletionCachePath(shell, binName);
	if (!await pathExists(cachePath)) {
		console.error(`Completion cache not found at ${cachePath}. Run \`${binName} completion --write-state\` first.`);
		return;
	}
	if (shell === "zsh") {
		profilePath = path.join(home, ".zshrc");
		sourceLine = formatCompletionSourceLine("zsh", binName, cachePath);
	} else if (shell === "bash") {
		profilePath = path.join(home, ".bashrc");
		try {
			await fs.access(profilePath);
		} catch {
			profilePath = path.join(home, ".bash_profile");
		}
		sourceLine = formatCompletionSourceLine("bash", binName, cachePath);
	} else if (shell === "fish") {
		profilePath = path.join(home, ".config", "fish", "config.fish");
		sourceLine = formatCompletionSourceLine("fish", binName, cachePath);
	} else {
		console.error(`Automated installation not supported for ${shell} yet.`);
		return;
	}
	try {
		try {
			await fs.access(profilePath);
		} catch {
			if (!yes) console.warn(`Profile not found at ${profilePath}. Created a new one.`);
			await fs.mkdir(path.dirname(profilePath), { recursive: true });
			await fs.writeFile(profilePath, "", "utf-8");
		}
		const update = updateCompletionProfile(await fs.readFile(profilePath, "utf-8"), binName, cachePath, sourceLine);
		if (!update.changed) {
			if (!yes) console.log(`Completion already installed in ${profilePath}`);
			return;
		}
		if (!yes) {
			const action = update.hadExisting ? "Updating" : "Installing";
			console.log(`${action} completion in ${profilePath}...`);
		}
		await fs.writeFile(profilePath, update.next, "utf-8");
		if (!yes) console.log(`Completion installed. Restart your shell or run: source ${profilePath}`);
	} catch (err) {
		console.error(`Failed to install completion: ${err}`);
	}
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

compdef _${rootCmd}_root_completion ${rootCmd}
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
	let script = "";
	for (const cmd of program.commands) {
		const cmdName = cmd.name();
		const funcName = `_${prefix}_${cmdName.replace(/-/g, "_")}`;
		script += generateZshSubcommands(cmd, `${prefix}_${cmdName.replace(/-/g, "_")}`);
		const subCommands = cmd.commands;
		if (subCommands.length > 0) script += `
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
`;
		else script += `
${funcName}() {
  _arguments -C \\
    ${generateZshArgs(cmd)}
}
`;
	}
	return script;
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
	const visit = (cmd, parents) => {
		const cmdName = cmd.name();
		const fullPath = [...parents, cmdName].join(" ");
		let script = "";
		const subCommands = cmd.commands.map((c) => c.name());
		const options = cmd.options.map((o) => o.flags.split(/[ ,|]+/)[0]);
		const allCompletions = [...subCommands, ...options].map((s) => `'${s}'`).join(",");
		if (allCompletions.length > 0) script += `
            if ($commandPath -eq '${fullPath}') {
                $completions = @(${allCompletions})
                $completions | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {
                    [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterName', $_)
                }
            }
`;
		for (const sub of cmd.commands) script += visit(sub, [...parents, cmdName]);
		return script;
	};
	const rootBody = visit(program, []);
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
	let script = "";
	const visit = (cmd, parents) => {
		const cmdName = cmd.name();
		const fullPath = [...parents];
		if (parents.length > 0) fullPath.push(cmdName);
		if (parents.length === 0) {
			for (const sub of cmd.commands) script += buildFishSubcommandCompletionLine({
				rootCmd,
				condition: "__fish_use_subcommand",
				name: sub.name(),
				description: sub.description()
			});
			for (const opt of cmd.options) script += buildFishOptionCompletionLine({
				rootCmd,
				condition: "__fish_use_subcommand",
				flags: opt.flags,
				description: opt.description
			});
		} else {
			for (const sub of cmd.commands) script += buildFishSubcommandCompletionLine({
				rootCmd,
				condition: `__fish_seen_subcommand_from ${cmdName}`,
				name: sub.name(),
				description: sub.description()
			});
			for (const opt of cmd.options) script += buildFishOptionCompletionLine({
				rootCmd,
				condition: `__fish_seen_subcommand_from ${cmdName}`,
				flags: opt.flags,
				description: opt.description
			});
		}
		for (const sub of cmd.commands) visit(sub, [...parents, cmdName]);
	};
	visit(program, []);
	return script;
}

//#endregion
export { resolveCompletionCachePath as a, isCompletionInstalled as i, completion_cli_exports as n, resolveShellFromEnv as o, installCompletion as r, usesSlowDynamicCompletion as s, completionCacheExists as t };