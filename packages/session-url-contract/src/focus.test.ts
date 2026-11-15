import { describe, expect, it } from "vitest";
import {
  buildControlUiFocusPath,
  inferControlUiFocusBasePath,
  parseControlUiFocusLocation,
  type ControlUiFocusBuildTarget,
  type ControlUiFocusTarget,
} from "./focus.js";

const sessionKey = "agent:a:b";
const dashboard = "/dashboard/a/task";
type RoundTripCase = [ControlUiFocusBuildTarget, string, ControlUiFocusTarget?, string?];
const browserQuery = "sessionKey=agent%3Aa%3Ab&";
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
      browserTarget({ target: "host", profile: "a.b", targetId: "t/1" }),
      `/focus/browser?${browserQuery}target=host&profile=a.b&targetId=t%2F1`,
    ],
    [
      browserTarget({ target: "node", node: "n/a", profile: "p", targetId: ".." }),
      `/ui/focus/browser?${browserQuery}target=node&profile=p&targetId=..&node=n%2Fa`,
      undefined,
      "/ui",
    ],
    [{ kind: "dashboard", path: dashboard }, `/focus${dashboard}`, dashboardTarget(dashboard)],
    [
      { kind: "dashboard", path: "/ui/dashboard/a?x=1#pane" },
      "/ui/focus/dashboard/a?x=1#pane",
      dashboardTarget("/ui/dashboard/a", "?x=1", "#pane"),
      "/ui/",
    ],
    [{ kind: "terminal" }, "/ui/focus/terminal", undefined, "/ui"],
    [{ kind: "desktop" }, "/focus/desktop", desktopTarget()],
    [
      { kind: "desktop", source: "env:A/B & C" },
      "/focus/desktop/source/env%3AA%2FB%20%26%20C",
      desktopTarget(false, { kind: "source", value: "env:A/B & C" }),
    ],
    [{ kind: "desktop", control: true }, "/focus/desktop/control", desktopTarget(true)],
    [
      { kind: "desktop", session: "a: b" },
      "/focus/desktop/session/a%3A%20b",
      desktopTarget(false, { kind: "session", value: "a: b" }),
    ],
    [
      { kind: "desktop", control: true, source: "n:a", session: "a:b" },
      "/focus/desktop/control/source/n%3Aa",
      desktopTarget(true, { kind: "source", value: "n:a" }),
    ],
    [{ kind: "desktop", source: " ", session: "" }, "/ui/focus/desktop", desktopTarget(), "/ui"],
  ])("round-trips %j", (target, path, parsed, basePath = "") => {
    expect(buildControlUiFocusPath(target, basePath)).toBe(path);
    expect(parseControlUiFocusLocation(new URL(path, "https://gateway.example.test"))).toEqual({
      status: "valid",
      basePath: basePath.replace(/\/$/u, ""),
      target: parsed ?? target,
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
    ].map((query) => ({ pathname: "/focus/browser", search: `?${query}` })),
    "/focus",
    "/focus/desktop/source",
    "/focus/desktop/session/%",
    "/focus/desktop/control/unknown/value",
  ])("rejects unsupported location %j", (input) => {
    expect(parseControlUiFocusLocation(input, typeof input === "string" ? "" : undefined)).toEqual({
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
    [
      "/focus/desktop/control/session/a%3Ab",
      "",
      desktopTarget(true, { kind: "session", value: "a:b" }),
    ],
  ] as const)("parses %s", (input, basePath, target) => {
    expect(parseControlUiFocusLocation(input, basePath)).toEqual({
      status: "valid",
      basePath,
      target,
    });
  });
});
