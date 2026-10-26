import { describe, expect, it } from "vitest";
import {
  buildControlUiFocusPath,
  inferControlUiFocusBasePath,
  parseControlUiFocusLocation,
  type ControlUiFocusBuildTarget,
  type ControlUiFocusTarget,
} from "./focus.js";

const sessionKey = "agent:main:work";
const dashboard = "/dashboard/roboclaw/the-daily-claw-6d7c9ccb";
type FocusInput = Parameters<typeof parseControlUiFocusLocation>[0];
type RoundTripCase = [ControlUiFocusBuildTarget, string, ControlUiFocusTarget?, string?];
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
  it.each<RoundTripCase>([
    [
      browserTarget({ target: "host", profile: "work.profile", targetId: "tab/1" }),
      `/focus/browser?${browserQuery}target=host&profile=work.profile&targetId=tab%2F1`,
    ],
    [
      browserTarget({ target: "node", node: "worker/a", profile: "work", targetId: ".." }),
      `/openclaw/focus/browser?${browserQuery}target=node&profile=work&targetId=..&node=worker%2Fa`,
      undefined,
      "/openclaw",
    ],
    [{ kind: "dashboard", path: dashboard }, `/focus${dashboard}`, dashboardTarget(dashboard)],
    [
      {
        kind: "dashboard",
        path: "/openclaw/dashboard/main?catalog=beam&host=gateway&thread=one#pane",
      },
      "/openclaw/focus/dashboard/main?catalog=beam&host=gateway&thread=one#pane",
      dashboardTarget("/openclaw/dashboard/main", "?catalog=beam&host=gateway&thread=one", "#pane"),
      "/openclaw/",
    ],
    [{ kind: "terminal" }, "/openclaw/focus/terminal", undefined, "/openclaw"],
    [{ kind: "desktop" }, "/focus/desktop", desktopTarget()],
    [
      { kind: "desktop", source: "environment:Mac Studio/QA & demo" },
      "/focus/desktop/source/environment%3AMac%20Studio%2FQA%20%26%20demo",
      desktopTarget(false, { kind: "source", value: "environment:Mac Studio/QA & demo" }),
    ],
    [{ kind: "desktop", control: true }, "/focus/desktop/control", desktopTarget(true)],
    [
      { kind: "desktop", session: "agent:main:mobile session" },
      "/focus/desktop/session/agent%3Amain%3Amobile%20session",
      desktopTarget(false, { kind: "session", value: "agent:main:mobile session" }),
    ],
    [
      { kind: "desktop", control: true, source: "node:worker-1", session: "agent:main:mobile" },
      "/focus/desktop/control/source/node%3Aworker-1",
      desktopTarget(true, { kind: "source", value: "node:worker-1" }),
    ],
    [
      { kind: "desktop", source: " ", session: "" },
      "/openclaw/focus/desktop",
      desktopTarget(),
      "/openclaw",
    ],
  ])("round-trips %j", (target, path, parsed = target, basePath = "") => {
    expect(buildControlUiFocusPath(target, basePath)).toBe(path);
    expect(parseControlUiFocusLocation(new URL(path, "https://gateway.example.test"))).toEqual({
      status: "valid",
      basePath: basePath.replace(/\/$/u, ""),
      target: parsed,
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

  it("rejects dashboard paths outside the configured base", () => {
    expect(buildControlUiFocusPath({ kind: "dashboard", path: dashboard }, "/openclaw")).toBeNull();
  });

  it.each([
    [`/openclaw/focus${dashboard}/`, "/openclaw", dashboardTarget(`/openclaw${dashboard}`)],
    ["/focus/desktop/", "", desktopTarget()],
    [
      "/focus/desktop/control/session/agent%3Amain%3Amobile",
      "",
      desktopTarget(true, { kind: "session", value: "agent:main:mobile" }),
    ],
  ] as const)("parses %s", (input, basePath, target) => {
    expect(parseControlUiFocusLocation(input, basePath)).toEqual({
      status: "valid",
      basePath,
      target,
    });
  });
});
