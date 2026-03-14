/** CLI commands for the Verdict plugin. */

import type { VerdictClient } from "./client.js";

type CliRegistrar = (ctx: {
  program: { command: (name: string) => CliCommand };
  config: unknown;
  logger: { info: (msg: string) => void };
}) => void;

type CliCommand = {
  description: (desc: string) => CliCommand;
  command: (name: string) => CliCommand;
  argument: (name: string, desc: string) => CliCommand;
  option: (flags: string, desc: string, defaultVal?: string) => CliCommand;
  action: (fn: (...args: unknown[]) => Promise<void>) => CliCommand;
};

export function createCliRegistrar(client: VerdictClient): CliRegistrar {
  return ({ program }) => {
    const verdict = program.command("verdict").description("Verdict policy engine commands");

    verdict
      .command("health")
      .description("Check Verdict gateway health")
      .action(async () => {
        try {
          const health = await client.health();
          console.log(`Status:          ${health.status}`);
          console.log(`Bundle digest:   ${health.bundle_digest}`);
          console.log(`Evaluations:     ${health.eval_count}`);
          console.log(`Latency p50:     ${health.p50_ms.toFixed(1)}ms`);
          console.log(`Latency p99:     ${health.p99_ms.toFixed(1)}ms`);
          console.log(`Shadow mode:     ${health.shadow_mode}`);
        } catch (err) {
          console.error(
            `Failed to reach Verdict gateway: ${err instanceof Error ? err.message : String(err)}`,
          );
          process.exitCode = 1;
        }
      });

    verdict
      .command("policies")
      .description("List loaded policies")
      .action(async () => {
        try {
          const discovery = await client.listPolicies();
          console.log(`Bundle: ${discovery.bundle_digest}`);
          console.log(`Policies: ${discovery.policy_count}\n`);

          for (const policy of discovery.policies) {
            const tools = policy.tools?.join(", ") ?? "*";
            const sop = policy.sop_ref ? ` (${policy.sop_ref})` : "";
            console.log(`  ${policy.name}${sop}`);
            if (policy.description) {
              console.log(`    ${policy.description}`);
            }
            console.log(`    Tools: ${tools}`);
            console.log(`    Source: ${policy.source}`);
            if (policy.rules?.length) {
              console.log(`    Rules: ${policy.rules.length}`);
            }
            console.log();
          }

          if (discovery.coverage) {
            console.log(`Coverage: ${discovery.coverage.coverage_percent.toFixed(0)}%`);
            if (discovery.coverage.tools_without_policies.length > 0) {
              console.log(
                `  Uncovered tools: ${discovery.coverage.tools_without_policies.join(", ")}`,
              );
            }
          }
        } catch (err) {
          console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
      });

    verdict
      .command("explain")
      .description("Explain a specific policy")
      .argument("<name>", "Policy name")
      .action(async (name: unknown) => {
        try {
          const explanation = await client.explainPolicy(String(name));
          console.log(`Policy: ${explanation.name}`);
          if (explanation.description) {
            console.log(`Description: ${explanation.description}`);
          }
          if (explanation.sop_ref) {
            console.log(`SOP ref: ${explanation.sop_ref}`);
          }
          if (explanation.summary) {
            console.log(`\nSummary: ${explanation.summary}`);
          }
          console.log(`Source: ${explanation.source}`);

          if (explanation.trigger?.tools?.length) {
            console.log(`\nTrigger tools: ${explanation.trigger.tools.join(", ")}`);
          }

          if (explanation.rules?.length) {
            console.log(`\nRules:`);
            for (const rule of explanation.rules) {
              const sev = rule.severity ? ` [${rule.severity}]` : "";
              console.log(`  ${rule.id}: ${rule.decision}${sev}`);
              if (rule.sop_ref) {
                console.log(`    Ref: ${rule.sop_ref}`);
              }
              if (rule.conditions?.length) {
                for (const cond of rule.conditions) {
                  console.log(`    When: ${cond.field} ${cond.op} ${cond.value}`);
                }
              }
              if (rule.repairs?.length) {
                for (const rep of rule.repairs) {
                  console.log(
                    `    Repair: ${rep.op}${rep.description ? ` — ${rep.description}` : ""}`,
                  );
                }
              }
            }
          }

          if (explanation.obligations?.length) {
            console.log(`\nObligations:`);
            for (const ob of explanation.obligations) {
              const fields = ob.fields?.join(", ") ?? "";
              console.log(
                `  ${ob.type}${ob.target ? ` → ${ob.target}` : ""}${fields ? ` [${fields}]` : ""}`,
              );
            }
          }
        } catch (err) {
          console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
      });

    verdict
      .command("traces")
      .description("Show policy decision summary")
      .option("--since <duration>", "Time range (e.g., 1h, 24h, 7d)", "24h")
      .action(async (...args: unknown[]) => {
        const opts = (args[0] ?? {}) as { since?: string };
        try {
          const summary = await client.tracesSummary(opts.since);
          console.log(`Time range: ${summary.time_range.from} → ${summary.time_range.to}`);
          console.log(`Total evaluations: ${summary.total_evaluations}\n`);

          console.log("Decisions:");
          for (const [dec, stats] of Object.entries(summary.decisions)) {
            console.log(`  ${dec}: ${stats.count} (${stats.pct.toFixed(1)}%)`);
          }

          if (summary.top_violated_policies?.length) {
            console.log("\nTop violated policies:");
            for (const p of summary.top_violated_policies) {
              console.log(`  ${p.policy_id}: ${p.count}`);
            }
          }

          if (summary.top_tools_by_denial_rate?.length) {
            console.log("\nTools by denial rate:");
            for (const t of summary.top_tools_by_denial_rate) {
              console.log(`  ${t.tool}: ${t.denied}/${t.total} (${t.denial_rate_pct.toFixed(1)}%)`);
            }
          }
        } catch (err) {
          console.error(`Failed: ${err instanceof Error ? err.message : String(err)}`);
          process.exitCode = 1;
        }
      });
  };
}
