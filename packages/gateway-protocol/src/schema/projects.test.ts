import { it } from "vitest";
import * as S from "../index.js";
import { check, copies, schemaValidation } from "./protocol-validation.test-support.js";

const gitUrl = "https://github.com/openclaw/openclaw.git";
const project = {
  id: "openclaw",
  displayName: "OpenClaw",
  repoRoot: "/repo/openclaw",
  originUrl: gitUrl,
  source: "registered",
};
const listResult = schemaValidation(S.ProjectsListResultSchema);
const summary = schemaValidation(S.ProjectSummarySchema);

it("validates closed project method inputs", () => {
  check(
    S.validateProjectsCheckoutOptionsParams,
    [{ projectId: "project", agentId: "main" }],
    [{ projectId: "project" }, { projectId: "project", agentId: "main", cwd: "/private" }],
  );
  check(
    S.validateProjectsListParams,
    [{}, { includeObserved: true }, { includeObserved: false }],
    [{ includeObserved: "yes" }, { extra: true }],
  );
  check(S.validateProjectsRegisterParams, [{ path: "/repo", name: "OpenClaw" }], [{ path: "" }]);
  check(S.validateProjectsAddParams, [{ gitUrl }], [{ gitUrl: "", unexpected: true }]);
  check(S.validateProjectsSearchRemoteParams, [{ query: "openclaw" }], [{ query: "" }]);
  check(
    S.validateProjectsRemoveParams,
    [{ id: "openclaw-2", deleteCheckout: true }],
    [{ id: "workspace:main" }],
  );
});
it("accepts remote search results", () => {
  schemaValidation(S.ProjectsSearchRemoteResultSchema).accepts({
    credential: "missing",
    projects: [
      {
        name: "openclaw",
        fullName: "openclaw/openclaw",
        cloneUrl: gitUrl,
        webUrl: "https://github.com/openclaw/openclaw",
        private: false,
      },
    ],
  });
});
it("accepts workspace and stored project records", () => {
  listResult.accepts({ projects: [] });
  listResult.accepts({
    projects: [
      project,
      { ...project, source: "cloned" },
      { id: "workspace:main", displayName: "openclaw", source: "workspace", agentId: "main" },
    ],
  });
  listResult.rejects({ observedProjects: [] });
});
it("bounds observed projects and checkout lists", () => {
  const observed = {
    name: "openclaw",
    originUrl: gitUrl,
    checkouts: [{ runnerId: "gateway", path: "/repo/openclaw" }],
    lastUsedAt: 1,
  };
  summary.accepts(observed);
  const checkouts = copies(observed.checkouts[0], S.PROJECTS_LIST_MAX_CHECKOUTS_PER_PROJECT + 1);
  summary.rejects({ ...observed, checkouts });
  const observedProjects = copies(observed, S.PROJECTS_LIST_DEFAULT_LIMIT + 1);
  listResult.rejects({ projects: [], observedProjects });
});
it("bounds additive session project IDs and remote URLs", () => {
  check(
    S.validateSessionsCreateParams,
    [
      { agentId: "main", projectId: "openclaw" },
      { agentId: "main", projectGitUrl: gitUrl },
    ],
    [
      { agentId: "main", projectId: "" },
      { agentId: "main", projectGitUrl: "" },
      { agentId: "main", projectGitUrl: "x".repeat(2_049) },
    ],
  );
});
