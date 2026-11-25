// `openclaw skills workshop ...`: inspect, archive and restore learned skills. Requests go to
// the running Gateway; the CLI reads or writes locally only when no Gateway owns the state.
import type {
  SkillsWorkshopChangeResult,
  SkillsWorkshopChangesResult,
  SkillsWorkshopListResult,
  SkillsWorkshopReadResult,
} from "@openclaw/gateway-protocol";
import type { Command } from "commander";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime";
import {
  applyParentDefaultHelpAction,
  formatCliCommand,
  formatTimeAgo,
  resolveSkillsWorkspace,
  routeSkillsCliRequest,
  runCommandWithRuntime,
  terminalText,
  theme,
  type ResolvedSkillsWorkspace,
} from "openclaw/plugin-sdk/skill-workshop-host-cli";
import { displayPath } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  archiveWorkshopSkill,
  listWorkshopChanges,
  restoreWorkshopSkill,
  viewWorkshopSkill,
} from "./library.js";
import { buildSkillsWorkshopListResult } from "./workshop-list.js";

const AGENT_OPTION_HELP = "Target agent (defaults to cwd-inferred, then default agent)";

function resolveAgentOption(command: Command | undefined): string | undefined {
  let current: Command | null | undefined = command;
  while (current) {
    const opts = current.opts<{ agent?: string }>();
    if (opts.agent !== undefined) {
      return opts.agent;
    }
    current = current.parent;
  }
  return undefined;
}

function parseStrictPositiveIntOption(value: string, flag: string): number {
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    // Commander recognizes parser failures by code; keep its import type-only.
    throw Object.assign(new Error(`${flag} must be a positive integer.`), {
      name: "InvalidArgumentError",
      code: "commander.invalidArgument",
      exitCode: 1,
    });
  }
  return parsed;
}

function formatSkillsWorkshopList(result: SkillsWorkshopListResult): string {
  const lines = [
    `${theme.muted("Agent:")} ${terminalText`${result.agentId}`}  ${theme.muted("Mode:")} ${terminalText`${result.mode}`}`,
    `${theme.muted("Root:")} ${displayPath(result.root)}`,
    "",
  ];
  if (result.skills.length === 0) {
    lines.push("No learned skills.");
  }
  for (const skill of result.skills) {
    const uses = skill.useCount === undefined ? "" : `  uses=${skill.useCount}`;
    lines.push(
      `${theme.command(terminalText`${skill.name}`)}${terminalText`  updated ${formatTimeAgo(Math.max(0, Date.now() - skill.updatedAtMs))}${uses}  ${skill.description}`}`,
    );
  }
  const archived = result.archived.filter((entry) => !entry.live);
  if (archived.length > 0) {
    lines.push("", theme.heading("Archived:"));
    for (const entry of archived) {
      lines.push(terminalText`${entry.name}  versions=${entry.versions.length}`);
    }
  }
  const drafts = result.drafts ?? [];
  if (drafts.length > 0) {
    lines.push("", theme.heading("Drafts (review with /learn drafts):"));
    for (const draft of drafts) {
      lines.push(terminalText`${draft.id}  for ${draft.skillName}  ${draft.summary}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatSkillsWorkshopChanges(result: SkillsWorkshopChangesResult): string {
  if (result.changes.length === 0) {
    return "No Workshop changes.\n";
  }
  return `${result.changes
    .map((change) => {
      const version = change.versionId ? `  version=${change.versionId}` : "";
      return terminalText`${formatTimeAgo(Math.max(0, Date.now() - change.createdAtMs))}  ${change.actor}  ${change.action}  ${change.skillName}  ${change.summary}${version}`;
    })
    .join("\n")}\n`;
}

function callSkillsWorkshop<T>(
  resolved: ResolvedSkillsWorkspace,
  method: "list" | "changes" | "read" | "archive" | "restore",
  params: Record<string, unknown>,
  loadLocal: () => Promise<T>,
): Promise<T> {
  return routeSkillsCliRequest({
    resolved,
    method: `skills.workshop.${method}`,
    params,
    mutation: method === "archive" || method === "restore",
    loadLocal,
  });
}

/** Builds `skills workshop` under the core `skills` command. */
function registerSkillsWorkshopCommands(skills: Command): void {
  // `openclaw skills --json workshop ...` keeps working like the core skills subcommands.
  const hasJsonOutput = (opts?: { json?: boolean }): boolean =>
    Boolean(opts?.json || skills.opts<{ json?: boolean }>().json);
  const workshop = skills
    .command("workshop")
    .description("Inspect, archive, and restore learned Workshop skills")
    .option("--agent <id>", AGENT_OPTION_HELP);

  const runWorkshopAction = async <T>(
    opts: { agent?: string; json?: boolean },
    command: Command,
    action: (resolved: ResolvedSkillsWorkspace) => Promise<T>,
    format: (result: T) => string,
  ): Promise<void> => {
    await runCommandWithRuntime(defaultRuntime, async () => {
      const result = await action(
        await resolveSkillsWorkspace({
          agentId: resolveAgentOption(command),
        }),
      );
      if (hasJsonOutput(opts)) {
        defaultRuntime.writeJson(result);
        return;
      }
      defaultRuntime.writeStdout(format(result));
    });
  };

  workshop
    .command("list")
    .description("List learned skills and archived skills")
    .option("--json", "Output as JSON", false)
    .action((opts: { json?: boolean; agent?: string }, command: Command) =>
      runWorkshopAction(
        opts,
        command,
        (resolved) =>
          callSkillsWorkshop<SkillsWorkshopListResult>(resolved, "list", {}, () =>
            buildSkillsWorkshopListResult(resolved),
          ),
        formatSkillsWorkshopList,
      ),
    );

  workshop
    .command("changes")
    .description("Show recent learned-skill changes")
    .option("--limit <n>", "Max changes", (value) => parseStrictPositiveIntOption(value, "--limit"))
    .option("--json", "Output as JSON", false)
    .action((opts: { limit?: number; json?: boolean; agent?: string }, command: Command) =>
      runWorkshopAction(
        opts,
        command,
        (resolved) =>
          callSkillsWorkshop<SkillsWorkshopChangesResult>(
            resolved,
            "changes",
            opts.limit === undefined ? {} : { limit: opts.limit },
            async () => ({
              changes: await listWorkshopChanges(resolved.agentId, { limit: opts.limit }),
            }),
          ),
        formatSkillsWorkshopChanges,
      ),
    );

  workshop
    .command("show")
    .description("Print a learned skill file")
    .argument("<name>", "Skill name")
    .option("--file <path>", "Skill file to print (default SKILL.md)")
    .option("--version <id>", "Print a saved version instead of the live skill")
    .option("--json", "Output as JSON", false)
    .action(
      (
        name: string,
        opts: { file?: string; version?: string; json?: boolean; agent?: string },
        command: Command,
      ) =>
        runWorkshopAction(
          opts,
          command,
          (resolved) =>
            callSkillsWorkshop<SkillsWorkshopReadResult>(
              resolved,
              "read",
              {
                name,
                ...(opts.file ? { filePath: opts.file } : {}),
                ...(opts.version ? { versionId: opts.version } : {}),
              },
              () =>
                viewWorkshopSkill(resolved.config, resolved.agentId, name, opts.file, opts.version),
            ),
          (skill) => (skill.content.endsWith("\n") ? skill.content : `${skill.content}\n`),
        ),
    );

  for (const method of ["archive", "restore"] as const) {
    const archive = method === "archive";
    const field = archive ? "reason" : "versionId";
    const mutate = archive ? archiveWorkshopSkill : restoreWorkshopSkill;
    workshop
      .command(method)
      .description(
        archive
          ? "Archive a learned skill so its agent no longer sees it"
          : "Restore an archived skill or a saved version",
      )
      .argument("<name>", "Skill name")
      .option(
        archive ? "--reason <text>" : "--version <id>",
        archive ? "Why the skill is archived" : "Version to restore (default newest)",
      )
      .option("--json", "Output as JSON", false)
      .action(
        (
          name: string,
          opts: { reason?: string; version?: string; json?: boolean; agent?: string },
          command: Command,
        ) =>
          runWorkshopAction(
            opts,
            command,
            (resolved) => {
              const value = archive ? opts.reason : opts.version;
              if (!archive && value === "") {
                throw new Error("--version must not be blank");
              }
              return callSkillsWorkshop<SkillsWorkshopChangeResult>(
                resolved,
                method,
                { name, ...(value ? { [field]: value } : {}) },
                async () => ({
                  change: await mutate(
                    { config: resolved.config, agentId: resolved.agentId, actor: "user" },
                    { name, [field]: value },
                  ),
                }),
              );
            },
            ({ change }) =>
              archive
                ? `Archived ${change.skillName}. Undo with: ${formatCliCommand(`openclaw skills workshop restore ${change.skillName} --agent ${change.agentId}`)}\n`
                : `Restored ${change.skillName}.\n`,
          ),
      );
  }

  for (const command of workshop.commands) {
    command.option("--agent <id>", AGENT_OPTION_HELP);
  }
  applyParentDefaultHelpAction(workshop);
}

export function registerSkillWorkshopCli(api: OpenClawPluginApi): void {
  api.registerCli(({ program }) => registerSkillsWorkshopCommands(program), {
    parentPath: ["skills"],
    descriptors: [
      {
        name: "workshop",
        description: "Inspect, archive, and restore learned Workshop skills",
        hasSubcommands: true,
      },
    ],
  });
}
