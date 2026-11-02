import { z } from "zod";
import { isGraphqlQuotaExhausted } from "../pr-lib/gh-api-preflight.mjs";
import { execGhJson } from "./plain-gh.mjs";

type ReadOptions = (deadline: number) => NonNullable<Parameters<typeof execGhJson>[1]>;

export const FAILURE_CONCLUSIONS: ReadonlySet<string> = new Set([
  "ACTION_REQUIRED",
  "CANCELLED",
  "FAILURE",
  "STARTUP_FAILURE",
  "STALE",
  "TIMED_OUT",
]);

const optional = <T,>(schema: z.ZodType<T>) => schema.optional().catch(undefined);
const optionalNullable = <T,>(schema: z.ZodType<T>) => optional(schema.nullable());
const validArray = <T,>(schema: z.ZodType<T>) =>
  z.array(z.unknown()).transform((values) =>
    values.flatMap((value) => {
      const parsed = schema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    }),
  );
const optionalString = optional(z.string());
const optionalNumber = optional(z.number());
const RollupCountSchema = z.object({ state: z.string(), count: z.number().int().nonnegative() });
const RollupCheckSchema = z.object({
  kind: z.enum(["CheckRun", "StatusContext"]),
  databaseId: optionalNumber,
  name: optionalString,
  context: optionalString,
  status: optionalString,
  conclusion: optionalNullable(z.string()),
  state: optionalString,
  checkSuite: optionalNullable(
    z.object({
      databaseId: optionalNumber,
      workflowRun: optionalNullable(
        z.object({
          databaseId: optionalNumber,
          event: optionalString,
          workflow: optional(z.object({ databaseId: optionalNumber })),
        }),
      ),
    }),
  ),
});
const RollupPayloadSchema = z.object({
  state: optionalString,
  contexts: optional(
    z.object({
      totalCount: optionalNumber,
      checkRunCountsByState: optional(z.array(RollupCountSchema)),
      statusContextCountsByState: optional(z.array(RollupCountSchema)),
      nodes: optional(validArray(RollupCheckSchema)),
      pageInfo: optional(
        z.object({
          hasNextPage: optional(z.boolean()),
          endCursor: optionalNullable(z.string()),
        }),
      ),
    }),
  ),
});
export const RollupPageSchema = z
  .object({
    state: optionalString,
    mergeable: optional(z.union([z.boolean(), z.string()])),
    headRefOid: optionalString,
    statusCheckRollup: optionalNullable(RollupPayloadSchema),
  })
  .catch({});
const RollupResponseSchema = z.object({
  data: z.object({
    repository: z.object({ pullRequest: RollupPageSchema.nullish() }).nullish(),
  }),
});

export type RollupCheck = z.infer<typeof RollupCheckSchema>;
export type RollupPayload = z.infer<typeof RollupPayloadSchema>;
export type RollupPage = z.infer<typeof RollupPageSchema>;

const ROLLUP_QUERY = `query($owner:String!,$name:String!,$pr:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$pr){state mergeable headRefOid statusCheckRollup{state contexts(first:100,after:$cursor){totalCount pageInfo{hasNextPage endCursor} nodes{kind:__typename ... on CheckRun{name status conclusion databaseId checkSuite{databaseId workflowRun{databaseId event workflow{databaseId}}}} ... on StatusContext{context state}}}}}}}`;
const SUMMARY_QUERY = `query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){state mergeable headRefOid statusCheckRollup{state contexts(first:1){checkRunCountsByState{state count} statusContextCountsByState{state count}}}}}}`;

export function collectRollupContexts(
  fetchPage: (cursor: string | null) => RollupPage | null | undefined,
) {
  const firstPage = fetchPage(null);
  const firstContexts = firstPage?.statusCheckRollup?.contexts;
  if (!firstContexts) {
    return firstPage;
  }

  const nodes = [...(firstContexts.nodes ?? [])];
  let pageInfo = firstContexts.pageInfo;
  let pageCount = 1;
  // Polling work stays bounded at 1,000 contexts. Any truncation remains visible through
  // totalCount and must classify conservatively rather than reading as success.
  while (pageInfo?.hasNextPage && pageCount < 10) {
    if (typeof pageInfo.endCursor !== "string") {
      throw new Error("rollup page advertised a next page without a cursor");
    }
    const page = fetchPage(pageInfo.endCursor);
    const contexts = page?.statusCheckRollup?.contexts;
    pageCount += 1;
    // Losing an advertised page (head moved, transient API gap) or reading a changed snapshot
    // must not pass off the partial first page as complete; the watch loop catches this error
    // and re-reads the rollup on its next bounded poll.
    if (!contexts) {
      throw new Error("rollup snapshot changed during pagination");
    }
    if (
      page.headRefOid !== firstPage.headRefOid ||
      page.statusCheckRollup?.state !== firstPage.statusCheckRollup?.state ||
      contexts.totalCount !== firstContexts.totalCount
    ) {
      throw new Error("rollup snapshot changed during pagination");
    }
    nodes.push(...(contexts.nodes ?? []));
    pageInfo = contexts.pageInfo;
  }

  return {
    ...firstPage,
    statusCheckRollup: {
      ...firstPage.statusCheckRollup,
      contexts: { ...firstContexts, nodes, pageInfo },
    },
  };
}

function readGraphqlRollup(
  pr: number,
  repo: string,
  deadline: number,
  details: boolean,
  readOptions: ReadOptions,
) {
  const [owner, name] = repo.split("/");
  const fetchPage = (cursor: string | null) => {
    const queryArgs = [
      "api",
      "graphql",
      "-f",
      `query=${details ? ROLLUP_QUERY : SUMMARY_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-f",
      `name=${name}`,
      "-F",
      `pr=${pr}`,
    ];
    if (cursor !== null) {
      queryArgs.push("-f", `cursor=${cursor}`);
    }
    const response = RollupResponseSchema.safeParse(execGhJson(queryArgs, readOptions(deadline)));
    return response.success ? response.data.data.repository?.pullRequest : undefined;
  };
  const page = (details ? collectRollupContexts(fetchPage) : fetchPage(null)) ?? {};
  const contexts = page.statusCheckRollup?.contexts;
  if (
    details &&
    page.statusCheckRollup &&
    (!contexts?.nodes ||
      contexts.totalCount !== contexts.nodes.length ||
      contexts.pageInfo?.hasNextPage !== false ||
      (contexts.totalCount === 0 &&
        ["FAILURE", "ERROR"].includes(page.statusCheckRollup.state ?? "")))
  ) {
    throw new Error("rollup detail evidence is incomplete");
  }
  return page;
}

const restId = z.number().int().positive();
const RestCheckSchema = z.object({
  id: restId,
  head_sha: z.string(),
  name: z.string().min(1),
  status: z.string().min(1),
  conclusion: z.string().nullable(),
  check_suite: z.object({ id: restId }),
});
const RestStatusSchema = z.object({
  id: restId,
  context: z.string().min(1),
  state: z.string().min(1),
});
const RestRunSchema = z.object({
  id: restId,
  check_suite_id: restId,
  workflow_id: restId,
  event: z.string().min(1),
  head_sha: z.string(),
});
const RestSuiteSchema = z.object({
  id: restId,
  head_sha: z.string(),
  status: z.string().min(1),
  conclusion: z.string().nullable(),
  latest_check_runs_count: z.number().int().nonnegative(),
});
const successful = (status: string | undefined, conclusion: string | null | undefined) =>
  status === "COMPLETED" && ["SUCCESS", "SKIPPED", "NEUTRAL"].includes(conclusion ?? "");

function readRestRollup(
  repo: string,
  deadline: number,
  requestedDetails: boolean,
  readPr: (deadline: number) => RollupPage,
  readOptions: ReadOptions,
) {
  const before = readPr(deadline);
  if (before.state !== "OPEN" || !/^[0-9a-f]{40}$/.test(before.headRefOid ?? "")) {
    return { page: before, details: requestedDetails };
  }
  const sha = before.headRefOid;
  const read = (endpoint: string) =>
    execGhJson(
      ["api", `repos/${repo}/${endpoint}`, "-H", "Cache-Control: max-age=0"],
      readOptions(deadline),
    );
  function pages<T>(endpoint: string, key: string, item: z.ZodType<T>) {
    const schema = z
      .object({
        total_count: z.number().int().nonnegative().max(1_000),
        sha: z.string().optional(),
        state: z.string().optional(),
      })
      .catchall(z.unknown());
    const values: T[] = [];
    let snapshot: string | undefined;
    for (let page = 1; page <= 10; page += 1) {
      const separator = endpoint.includes("?") ? "&" : "?";
      const response = schema.parse(read(`${endpoint}${separator}per_page=100&page=${page}`));
      const count = response.total_count;
      const items = z.array(item).max(100).parse(response[key]);
      const current = JSON.stringify([count, response.sha, response.state]);
      if (
        (key === "statuses" && (response.sha !== sha || response.state === undefined)) ||
        (snapshot !== undefined && snapshot !== current)
      ) {
        throw new Error("REST check evidence changed during pagination");
      }
      snapshot = current;
      values.push(...items);
      if (values.length >= count) {
        if (values.length !== count) {
          throw new Error("REST check evidence has an inconsistent page count");
        }
        return { items: values, state: response.state };
      }
      if (items.length === 0) {
        break;
      }
    }
    throw new Error("REST check evidence pagination is incomplete");
  }
  const { items: checks } = pages(
    `commits/${sha}/check-runs?filter=latest`,
    "check_runs",
    RestCheckSchema,
  );
  const { items: statuses, state: statusState } = pages(
    `commits/${sha}/status`,
    "statuses",
    RestStatusSchema,
  );
  const expectedStatusState = statuses.some((status) => ["error", "failure"].includes(status.state))
    ? "failure"
    : statuses.length === 0 || statuses.some((status) => status.state !== "success")
      ? "pending"
      : "success";
  if (
    statusState !== expectedStatusState ||
    checks.some((check) => check.head_sha !== sha) ||
    new Set(checks.map((check) => check.id)).size !== checks.length ||
    new Set(statuses.map((status) => status.context)).size !== statuses.length
  ) {
    throw new Error("REST check evidence has inconsistent identities or aggregate");
  }
  const failed =
    statuses.some((status) => ["ERROR", "FAILURE"].includes(status.state.toUpperCase())) ||
    checks.some((check) => FAILURE_CONCLUSIONS.has(check.conclusion?.toUpperCase() ?? ""));
  // REST already collected the check rows; finish failure analysis in this snapshot.
  const details = requestedDetails || failed;
  const runs = details
    ? pages(
        `actions/runs?head_sha=${sha}&exclude_pull_requests=true`,
        "workflow_runs",
        RestRunSchema,
      ).items
    : [];
  if (
    runs.some((run) => run.head_sha !== sha) ||
    new Set(runs.map((run) => run.id)).size !== runs.length
  ) {
    throw new Error("REST workflow evidence has duplicate or mismatched identities");
  }
  const suites = new Map<number, z.infer<typeof RestRunSchema> | null>();
  for (const run of runs) {
    suites.set(run.check_suite_id, suites.has(run.check_suite_id) ? null : run);
  }
  const nodes: RollupCheck[] = [
    ...checks.map((check): RollupCheck => {
      const run = suites.get(check.check_suite.id);
      return {
        kind: "CheckRun",
        databaseId: check.id,
        name: check.name,
        status: check.status.toUpperCase(),
        conclusion: check.conclusion?.toUpperCase() ?? null,
        checkSuite: {
          databaseId: check.check_suite.id,
          // An absent or ambiguous join retains the check without supersession authority.
          workflowRun: run
            ? {
                databaseId: run.id,
                event: run.event,
                workflow: { databaseId: run.workflow_id },
              }
            : null,
        },
      };
    }),
    ...statuses.map((status): RollupCheck => ({
      kind: "StatusContext",
      context: status.context,
      state: status.state.toUpperCase(),
    })),
  ];
  const success =
    nodes.length > 0 &&
    nodes.every((check) =>
      check.kind === "StatusContext"
        ? check.state === "SUCCESS"
        : successful(check.status, check.conclusion),
    );
  // GitHub silently restricts commit check-runs to the most recent 1,000 suites.
  // Fresh suite outcomes also catch reruns while successful check pages were read.
  const { items: currentSuites } = pages(
    `commits/${sha}/check-suites`,
    "check_suites",
    RestSuiteSchema,
  );
  const suitesById = new Map(currentSuites.map((suite) => [suite.id, suite]));
  if (
    suitesById.size !== currentSuites.length ||
    currentSuites.some((suite) => suite.head_sha !== sha) ||
    checks.some((check) => !suitesById.has(check.check_suite.id))
  ) {
    throw new Error("REST check-suite evidence is incomplete or inconsistent");
  }
  const checksBySuite = new Map<number, { count: number; allSuccessful: boolean }>();
  for (const check of checks) {
    const id = check.check_suite.id;
    const group = checksBySuite.get(id) ?? { count: 0, allSuccessful: true };
    group.count += 1;
    group.allSuccessful &&= successful(check.status.toUpperCase(), check.conclusion?.toUpperCase());
    checksBySuite.set(id, group);
  }
  for (const suite of currentSuites) {
    const group = checksBySuite.get(suite.id);
    if (suite.latest_check_runs_count !== (group?.count ?? 0)) {
      throw new Error("REST check suite contains uncollected check evidence");
    }
    // Installed apps can have empty queued suites; they are not rollup contexts.
    if (
      group?.allSuccessful &&
      !successful(suite.status.toUpperCase(), suite.conclusion?.toUpperCase())
    ) {
      throw new Error("REST check-suite outcome changed during collection");
    }
  }
  const current = readPr(deadline);
  if (JSON.stringify(current) !== JSON.stringify(before)) {
    return { page: current, details };
  }
  const counts = (states: string[]) => {
    const totals = new Map<string, number>();
    for (const state of states) {
      totals.set(state, (totals.get(state) ?? 0) + 1);
    }
    return [...totals].map(([state, count]) => ({ state, count }));
  };
  return {
    page: {
      ...current,
      statusCheckRollup: {
        state: failed ? "FAILURE" : success ? "SUCCESS" : "PENDING",
        contexts: {
          totalCount: nodes.length,
          checkRunCountsByState: counts(
            checks.map((check) =>
              (check.status === "completed"
                ? (check.conclusion ?? "UNKNOWN")
                : check.status
              ).toUpperCase(),
            ),
          ),
          statusContextCountsByState: counts(statuses.map((status) => status.state.toUpperCase())),
          nodes,
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    },
    details,
  };
}

export function createPrRollupReader(
  pr: number,
  repo: string,
  readPr: (deadline: number) => RollupPage,
  readOptions: ReadOptions,
) {
  let rest = false;
  return (deadline: number, details = true) => {
    if (!rest) {
      try {
        return { page: readGraphqlRollup(pr, repo, deadline, details, readOptions), details };
      } catch (error) {
        if (!isGraphqlQuotaExhausted(error)) {
          throw error;
        }
        rest = true;
        console.log("WARN GraphQL quota exhausted; using REST check evidence for this watcher");
      }
    }
    return readRestRollup(repo, deadline, details, readPr, readOptions);
  };
}
