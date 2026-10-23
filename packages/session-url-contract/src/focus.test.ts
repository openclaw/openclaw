import { describe, expect, it } from "vitest";
import {
  buildControlUiFocusPath,
  inferControlUiFocusBasePath,
  parseControlUiFocusLocation,
  type ControlUiFocusTarget,
} from "./focus.js";

const sessionKey = "agent:main:work";
const dashboard = "/dashboard/roboclaw/the-daily-claw-6d7c9ccb";
type FocusInput = Parameters<typeof parseControlUiFocusLocation>[0];
type ParseCase = [FocusInput, string | undefined, ControlUiFocusTarget, string?];
const browserQuery = "sessionKey=agent%3Amain%3Awork&";
const browserLocation = (query: string, base = "") => ({
  pathname: `${base}/focus/browser`,
  search: `?${query}`,
});
const browserTarget = (tab: Extract<ControlUiFocusTarget, { kind: "browser" }>["tab"]) =>
  ({ kind: "browser", sessionKey, tab }) as const;
const dashboardTarget = (pathname: string, search = "", hash = "") =>
  ({ kind: "dashboard", route: { pathname, search, hash } }) as const;
const desktopTarget = (
  control = false,
  selector: Extract<ControlUiFocusTarget, { kind: "desktop" }>["selector"] = null,
) => ({ kind: "desktop", control, selector }) as const;

describe("Control UI focus locations", () => {
  it.each<ParseCase>([
    [
      browserLocation(
        `${browserQuery}target=host&profile=work.profile&targetId=tab%2F1`,
        "/openclaw",
      ),
      undefined,
      browserTarget({ target: "host", profile: "work.profile", targetId: "tab/1" }),
      "/openclaw",
    ],
    [
      browserLocation(
        `${browserQuery}target=node&node=node%2Fone&profile=work&targetId=..`,
        "/openclaw",
      ),
      undefined,
      browserTarget({ target: "node", node: "node/one", profile: "work", targetId: ".." }),
      "/openclaw",
    ],
    [`/focus${dashboard}`, undefined, dashboardTarget(dashboard)],
    [`/openclaw/focus${dashboard}/`, "/openclaw", dashboardTarget(`/openclaw${dashboard}`)],
    [
      {
        pathname: "/focus/dashboard/main",
        search: "?catalog=beam&host=gateway&thread=one",
        hash: "#pane",
      },
      undefined,
      dashboardTarget("/dashboard/main", "?catalog=beam&host=gateway&thread=one", "#pane"),
    ],
    ["/focus/terminal", "", { kind: "terminal" }],
    ["/focus/desktop/", "", desktopTarget()],
    [
      "/focus/desktop/source/environment%3AMac%20Studio%2FQA%20%26%20demo",
      "",
      desktopTarget(false, { kind: "source", value: "environment:Mac Studio/QA & demo" }),
    ],
    ["/focus/desktop/control", "", desktopTarget(true)],
    [
      "/focus/desktop/control/session/agent%3Amain%3Amobile",
      "",
      desktopTarget(true, { kind: "session", value: "agent:main:mobile" }),
    ],
  ])("parses %j", (input, basePath, target, expectedBase = basePath ?? "") => {
    expect(parseControlUiFocusLocation(input, basePath)).toEqual({
      status: "valid",
      basePath: expectedBase,
      target,
    });
  });

  it.each([
    ...[
      "",
      `${browserQuery}target=host&profile=work`,
      `${browserQuery}target=node&profile=work&targetId=one`,
      `${browserQuery}target=host&node=other&profile=work&targetId=one`,
      `${browserQuery}target=host&profile=work&targetId=one&targetId=two`,
      "sessionKey=%20&target=host&profile=work&targetId=one",
    ].map((query): [FocusInput, string | undefined] => [browserLocation(query), undefined]),
    ...[
      "/focus",
      "/focus/desktop/source",
      "/focus/desktop/session/%",
      "/focus/desktop/control/unknown/value",
    ].map((input): [FocusInput, string] => [input, ""]),
  ])("rejects unsupported location %j", (input, basePath) => {
    expect(parseControlUiFocusLocation(input, basePath)).toEqual({
      status: "unsupported",
      basePath: "",
    });
  });
  it.each(["/?view=dashboard&session=agent%3Amain%3Awork", "/focused/terminal"])(
    "ignores %s",
    (input) => {
      expect(parseControlUiFocusLocation(input, "")).toBeNull();
    },
  );

  it("infers focus-aware base paths without overriding an explicit base", () => {
    expect(inferControlUiFocusBasePath("/focus/terminal")).toBe("");
    expect(inferControlUiFocusBasePath("/openclaw/focus/desktop")).toBe("/openclaw");
    expect(inferControlUiFocusBasePath("/company/focus/focus/terminal")).toBe("/company/focus");
    expect(inferControlUiFocusBasePath("/focused/terminal")).toBeNull();
    expect(parseControlUiFocusLocation("/openclaw/focus/terminal", "/other")).toBeNull();
  });

  it.each([
    [
      browserTarget({ target: "node", node: "worker/a", profile: "work", targetId: ".." }),
      "/openclaw",
      "/openclaw/focus/browser?sessionKey=agent%3Amain%3Awork&target=node&profile=work&targetId=..&node=worker%2Fa",
    ],
    [{ kind: "dashboard", path: dashboard }, "", `/focus${dashboard}`],
    [
      { kind: "dashboard", path: "/openclaw/dashboard/roboclaw/main?catalog=beam#pane" },
      "/openclaw/",
      "/openclaw/focus/dashboard/roboclaw/main?catalog=beam#pane",
    ],
    [{ kind: "terminal" }, "/openclaw", "/openclaw/focus/terminal"],
    [{ kind: "desktop" }, "", "/focus/desktop"],
    [
      { kind: "desktop", source: "environment:Mac Studio/QA & demo" },
      "",
      "/focus/desktop/source/environment%3AMac%20Studio%2FQA%20%26%20demo",
    ],
    [
      { kind: "desktop", session: "agent:main:mobile session" },
      "",
      "/focus/desktop/session/agent%3Amain%3Amobile%20session",
    ],
    [
      { kind: "desktop", control: true, source: "node:worker-1", session: "agent:main:mobile" },
      "",
      "/focus/desktop/control/source/node%3Aworker-1",
    ],
    [{ kind: "desktop", source: " ", session: "" }, "/openclaw", "/openclaw/focus/desktop"],
    [{ kind: "dashboard", path: "/dashboard/roboclaw/main" }, "/openclaw", null],
  ] as const)("builds %j", (target, basePath, expected) => {
    expect(buildControlUiFocusPath(target, basePath)).toBe(expected);
  });
});
