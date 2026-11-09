import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withTestRunAdmission } from "./admitted-run-context.test-support.js";
import { buildPreparedCliRunContext } from "./cli-runner.test-helpers.js";
import { executePreparedCliRun } from "./cli-runner/execute.js";

const directories = useAutoCleanupTempDirTracker(afterEach);

it.each(["arg", "stdin"] as const)(
  "checks private input at the real %s process boundary",
  async (input) => {
    const root = directories.make("cli-private-input-");
    for (const revoked of [false, true]) {
      const output = path.join(root, `${input}-${revoked}.txt`);
      const publish =
        "const publish=text=>{require('node:fs').writeFileSync(" +
        JSON.stringify(output) +
        ",JSON.stringify({text,args:process.argv.slice(1)}));process.stdout.write('done')};";
      const script =
        publish +
        (input === "arg"
          ? "publish('')"
          : "let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>text+=chunk);process.stdin.on('end',()=>publish(text))");
      const context = buildPreparedCliRunContext({
        provider: "google-gemini-cli",
        workspaceDir: root,
        prompt: "Private native history\nCurrent request",
        runId: `private-input-${input}-${revoked}`,
        timeoutMs: 10_000,
        backend: {
          command: process.execPath,
          args: ["-e", script, "--"],
          input,
          output: "text",
          sessionMode: "none",
        },
      });
      let authorized = true;
      Object.assign(context.params, {
        assertPrivateInputCurrent: () => {
          if (!authorized) {
            throw new Error("Private input authorization changed");
          }
        },
      });
      context.preparedBackend.beforeExecution = async () => {
        await Promise.resolve();
        authorized = !revoked;
      };
      const run = withTestRunAdmission(context.params, async (admitted) => {
        context.params.admittedRunContext = admitted;
        return executePreparedCliRun(context);
      });
      if (revoked) {
        await expect(run).rejects.toThrow("Private input authorization changed");
        await expect(fs.readFile(output, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
      } else {
        expect((await run).text).toBe("done");
        expect(await fs.readFile(output, "utf8")).toContain("Private native history");
      }
    }
  },
);
