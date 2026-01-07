import chalk from "chalk";
import { Command } from "commander";
import { listSessions, resetSession, runClawdAgent } from "../agents/runner.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { loadConfig } from "../config/index.js";
import type { ThinkLevel } from "../config/types.js";

export const program = new Command();

program
  .name("clawd")
  .description("Clawd Core - Standalone AI agent with workspace and skills")
  .version("0.1.0");

// Agent command - run the agent with a message
program
  .command("agent")
  .alias("a")
  .description("Run the agent with a message")
  .option("-m, --message <message>", "Message to send to the agent")
  .option("-s, --session <key>", "Session key to use")
  .option("-t, --thinking <level>", "Thinking level: off, low, medium, high")
  .option("-c, --config <path>", "Config file path")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const config = loadConfig(opts.config);

    if (!opts.message) {
      // Interactive mode - read from stdin
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      opts.message = Buffer.concat(chunks).toString("utf-8").trim();
    }

    if (!opts.message) {
      console.error(chalk.red("Error: No message provided"));
      console.error("Usage: clawd agent -m 'your message' or pipe to stdin");
      process.exit(1);
    }

    try {
      const result = await runClawdAgent({
        message: opts.message,
        sessionKey: opts.session,
        config,
        thinkingLevel: opts.thinking as ThinkLevel,
        onTextChunk: opts.json
          ? undefined
          : (text) => process.stdout.write(text),
        onToolUse: opts.json
          ? undefined
          : (name, _input) => {
              console.error(chalk.dim(`\n[tool: ${name}]`));
            },
      });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(); // newline after streaming output
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (opts.json) {
        console.log(JSON.stringify({ error: message }));
      } else {
        console.error(chalk.red(`Error: ${message}`));
      }
      process.exit(1);
    }
  });

// Chat command - interactive chat mode
program
  .command("chat")
  .description("Start an interactive chat session")
  .option("-s, --session <key>", "Session key to use")
  .option("-t, --thinking <level>", "Thinking level: off, low, medium, high")
  .option("-c, --config <path>", "Config file path")
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const readline = await import("node:readline");

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    console.log(chalk.cyan("Clawd Chat"));
    console.log(
      chalk.dim(
        "Type your message and press Enter. Type /quit to exit, /new to reset session.",
      ),
    );
    console.log();

    const prompt = () => {
      rl.question(chalk.green("You: "), async (input) => {
        const trimmed = input.trim();

        if (trimmed === "/quit" || trimmed === "/exit") {
          console.log(chalk.dim("Goodbye!"));
          rl.close();
          return;
        }

        if (trimmed === "/new" || trimmed === "/reset") {
          await resetSession({ sessionKey: opts.session, config });
          console.log(chalk.dim("Session reset."));
          prompt();
          return;
        }

        if (!trimmed) {
          prompt();
          return;
        }

        process.stdout.write(chalk.blue("Clawd: "));

        try {
          await runClawdAgent({
            message: trimmed,
            sessionKey: opts.session,
            config,
            thinkingLevel: opts.thinking as ThinkLevel,
            onTextChunk: (text) => process.stdout.write(text),
            onToolUse: (name) => {
              process.stdout.write(chalk.dim(`\n[${name}] `));
            },
          });
          console.log(); // newline after response
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(chalk.red(`\nError: ${message}`));
        }

        console.log();
        prompt();
      });
    };

    prompt();
  });

// Sessions command
program
  .command("sessions")
  .description("Manage sessions")
  .option("-c, --config <path>", "Config file path")
  .action((opts) => {
    const config = loadConfig(opts.config);
    const sessions = listSessions({ config });

    if (sessions.length === 0) {
      console.log(chalk.dim("No sessions found."));
      return;
    }

    console.log(chalk.cyan("Sessions:"));
    for (const session of sessions) {
      const date = new Date(session.updatedAt).toLocaleString();
      console.log(`  ${chalk.green(session.sessionKey)}`);
      console.log(`    ID: ${session.sessionId}`);
      console.log(`    Updated: ${date}`);
    }
  });

// Reset command
program
  .command("reset")
  .description("Reset the current session")
  .option("-s, --session <key>", "Session key to reset")
  .option("-c, --config <path>", "Config file path")
  .action(async (opts) => {
    const config = loadConfig(opts.config);
    const result = await resetSession({
      sessionKey: opts.session,
      config,
    });
    console.log(chalk.green(`Session reset: ${result.sessionKey}`));
    console.log(chalk.dim(`New session ID: ${result.sessionId}`));
  });

// Init command - initialize workspace
program
  .command("init")
  .description("Initialize the Clawd workspace")
  .option("-d, --dir <path>", "Workspace directory")
  .action(async (opts) => {
    const result = await ensureAgentWorkspace({
      dir: opts.dir,
      ensureBootstrapFiles: true,
    });

    console.log(chalk.green(`Workspace initialized at: ${result.dir}`));
    console.log();
    console.log("Created files:");
    if (result.agentsPath) console.log(`  - ${chalk.cyan("AGENTS.md")}`);
    if (result.identityPath) console.log(`  - ${chalk.cyan("IDENTITY.md")}`);
    if (result.userPath) console.log(`  - ${chalk.cyan("USER.md")}`);
    if (result.soulPath) console.log(`  - ${chalk.cyan("SOUL.md")}`);
    if (result.toolsPath) console.log(`  - ${chalk.cyan("TOOLS.md")}`);
    if (result.heartbeatPath) console.log(`  - ${chalk.cyan("HEARTBEAT.md")}`);
    if (result.bootstrapPath)
      console.log(`  - ${chalk.cyan("BOOTSTRAP.md")} (first-run ritual)`);
    console.log();
    console.log(chalk.dim("Run 'clawd chat' to start chatting!"));
  });
