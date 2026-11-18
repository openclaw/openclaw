import { createHash } from "node:crypto";
import { z } from "zod";
import { parseGithubResponse } from "../pr-lib/gh-api-preflight.mjs";
import { execPrGh } from "../pr-lib/github.mjs";

const RunSchema = z.object({
  id: z.number().int().positive(),
  head_sha: z.string(),
  run_attempt: z.number().int().positive(),
  status: z.string(),
  conclusion: z.string().nullable(),
});
const JobsSchema = z.object({
  total_count: z.number().int().nonnegative().max(1_000),
  jobs: z
    .array(
      z.object({
        name: z.string().min(1),
        status: z.string().min(1),
        conclusion: z.string().nullable(),
      }),
    )
    .max(100),
});
type ReadOptions = (deadline: number) => { timeout?: number; env?: NodeJS.ProcessEnv };

export function createCiRunReader(repo: string, headSha: string, readOptions: ReadOptions) {
  const validators = new Map<string, { etag?: string; body: unknown }>();
  function read(host: string, endpoint: string, deadline: number): unknown {
    const options = readOptions(deadline);
    const env = options.env ?? process.env;
    const scope = createHash("sha256")
      .update(
        JSON.stringify([
          env.PATH,
          env.HOME,
          env.GH_CONFIG_DIR,
          env.GH_HOST,
          env.GH_TOKEN,
          env.GITHUB_TOKEN,
          env.GH_ENTERPRISE_TOKEN,
          env.GITHUB_ENTERPRISE_TOKEN,
        ]),
      )
      .digest("hex");
    const key = scope + "\0" + host + "\0" + endpoint;
    const previous = validators.get(key);
    const args = [
      "api",
      "--hostname",
      host,
      endpoint,
      "--include",
      "-H",
      "Cache-Control: max-age=0",
      ...(previous?.etag ? ["-H", "If-None-Match: " + previous.etag] : []),
    ];
    let output: string;
    try {
      output = execPrGh(args, { ...options, encoding: "utf8" });
    } catch (error) {
      // Native gh reports a bodyless 304 as exit 1, not a successful API read.
      if (
        error instanceof Error &&
        "status" in error &&
        error.status === 1 &&
        "stdout" in error &&
        typeof error.stdout === "string" &&
        parseGithubResponse(error.stdout).status === "304"
      ) {
        output = error.stdout;
      } else {
        throw error;
      }
    }
    const response = parseGithubResponse(output);
    if (response.status === "304" && previous?.etag) {
      return previous.body;
    }
    if (response.status !== "200" || response.body == null) {
      throw new Error("GitHub returned invalid conditional CI evidence");
    }
    const headerEnd = /\r?\n\r?\n/.exec(output)?.index ?? 0;
    const etag = /^etag:[ \t]*([^\r\n]+)/im.exec(output.slice(0, headerEnd))?.[1]?.trim();
    validators.set(key, { etag, body: response.body });
    return response.body;
  }
  return (runId: number, prUrl: string, deadline: number) => {
    const host = new URL(prUrl).host;
    const endpoint = "repos/" + repo + "/actions/runs/" + runId;
    const run = RunSchema.parse(read(host, endpoint, deadline));
    if (run.id !== runId || run.head_sha !== headSha) {
      throw new Error("GitHub returned CI evidence for another run or head");
    }
    // Completed run status is sufficient; job rows only explain active progress.
    if (run.status === "completed") {
      return run;
    }
    const jobs: z.infer<typeof JobsSchema>["jobs"] = [];
    let total: number | undefined;
    for (let page = 1; page <= 10; page += 1) {
      const response = JobsSchema.safeParse(
        read(
          host,
          endpoint + "/attempts/" + run.run_attempt + "/jobs?per_page=100&page=" + page,
          deadline,
        ),
      );
      if (!response.success) {
        return run;
      }
      total ??= response.data.total_count;
      if (total !== response.data.total_count) {
        return run;
      }
      jobs.push(...response.data.jobs);
      if (jobs.length === total) {
        return { ...run, jobs };
      }
      if (jobs.length > total || response.data.jobs.length === 0) {
        return run;
      }
    }
    return run;
  };
}
