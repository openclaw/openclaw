// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SkillStorePanel } from "./skill-store-panel";
import type { InstalledSkillData } from "./skill-card";

const browseSkill = {
  slug: "nextjs",
  displayName: "Next.js",
  summary: "by vercel/next.js",
  installs: 42,
  source: "vercel/next.js",
};

const featuredSkills = [
  { slug: "react-best", displayName: "React Best Practices", summary: "by vercel-labs/agent-skills", installs: 263732, source: "vercel-labs/agent-skills" },
  { slug: "ai-image", displayName: "AI Image Generation", summary: "by inferen-sh/skills", installs: 114777, source: "inferen-sh/skills" },
];

const categories = ["React", "Next.js", "AI", "Python", "TypeScript", "DevOps", "Testing", "Databases"];

const installedSkill: InstalledSkillData = {
  name: "Next.js",
  slug: "nextjs",
  description: "The official Next.js skill.",
  source: "skills.sh",
  filePath: "/tmp/workspace/skills/nextjs/SKILL.md",
  protected: false,
};

function getUrl(input: RequestInfo | URL): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function makeFetch({
  installedList = [] as InstalledSkillData[],
  browseList = [browseSkill],
  installFn,
  alwaysEmptyInstalled = false,
  includeFeatured = true,
}: {
  installedList?: InstalledSkillData[];
  browseList?: typeof browseSkill[];
  installFn?: () => Promise<Response>;
  alwaysEmptyInstalled?: boolean;
  includeFeatured?: boolean;
} = {}) {
  let installedCalls = 0;
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = getUrl(input);
    const method = init?.method ?? "GET";

    if (url === "/api/skills" && method === "GET") {
      installedCalls += 1;
      const skills = alwaysEmptyInstalled
        ? []
        : installedCalls === 1
          ? installedList
          : [...installedList, installedSkill];
      return Promise.resolve(new Response(JSON.stringify({ skills })));
    }

    if (url.startsWith("/api/skills/browse") && method === "GET") {
      const u = new URL(url, "http://localhost");
      if (u.searchParams.get("featured") === "true") {
        return Promise.resolve(new Response(JSON.stringify({
          skills: includeFeatured ? featuredSkills : [],
          categories,
        })));
      }
      return Promise.resolve(new Response(JSON.stringify({ skills: browseList, categories })));
    }

    if (url === "/api/skills/install" && method === "POST") {
      if (installFn) return installFn();
      return Promise.resolve(new Response(JSON.stringify({ ok: true, slug: "nextjs", skill: installedSkill })));
    }

    if (url.match(/\/api\/skills\/[^/]+\/content/) && method === "GET") {
      return Promise.resolve(new Response(JSON.stringify({ content: "# Skill Content\nSome details." })));
    }

    throw new Error(`Unexpected fetch: ${method} ${url}`);
  }) as typeof fetch;
}

describe("SkillStorePanel", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("shows install progress and success feedback", async () => {
    const user = userEvent.setup();
    let resolveInstall: ((v: Response) => void) | undefined;
    const installPromise = new Promise<Response>((r) => { resolveInstall = r; });

    global.fetch = makeFetch({ installFn: () => installPromise, includeFeatured: false });

    render(<SkillStorePanel />);

    await user.click(screen.getByRole("button", { name: "Browse" }));

    await waitFor(() => {
      expect(screen.getAllByText("Next.js").length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole("button", { name: "Install" }));
    expect(screen.getByText("Installing...")).toBeInTheDocument();

    resolveInstall?.(new Response(JSON.stringify({ ok: true, slug: "nextjs", skill: installedSkill })));

    await waitFor(() => {
      expect(screen.getByText("Next.js is now installed.")).toBeInTheDocument();
    });

    expect(screen.getAllByText("Installed").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Installed" }));

    await waitFor(() => {
      expect(screen.getAllByText("Next.js").length).toBeGreaterThan(0);
    });
  });

  it("shows an error when install fails", async () => {
    const user = userEvent.setup();

    global.fetch = makeFetch({
      installFn: () => Promise.resolve(new Response(JSON.stringify({
        ok: false,
        error: "Install failed: GitHub rate limit exceeded",
      }), { status: 500 })),
      includeFeatured: false,
    });

    render(<SkillStorePanel />);

    await user.click(screen.getByRole("button", { name: "Browse" }));

    await waitFor(() => {
      expect(screen.getAllByText("Next.js").length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => {
      expect(screen.getAllByText("Install failed: GitHub rate limit exceeded").length).toBeGreaterThan(0);
    });

    expect(screen.getByRole("button", { name: "Install" })).toBeInTheDocument();
  });

  it("keeps a newly installed skill visible even if the follow-up refresh is empty", async () => {
    const user = userEvent.setup();

    global.fetch = makeFetch({ alwaysEmptyInstalled: true, includeFeatured: false });

    render(<SkillStorePanel />);

    await user.click(screen.getByRole("button", { name: "Browse" }));

    await waitFor(() => {
      expect(screen.getAllByText("Next.js").length).toBeGreaterThan(0);
    });

    await user.click(screen.getByRole("button", { name: "Install" }));

    await waitFor(() => {
      expect(screen.getByText("Next.js is now installed.")).toBeInTheDocument();
    });

    expect(screen.getAllByText("Installed").length).toBeGreaterThan(0);

    await user.click(screen.getByRole("button", { name: "Installed" }));

    await waitFor(() => {
      expect(screen.getAllByText("Next.js").length).toBeGreaterThan(0);
    });
  });

  it("shows featured / popular skills on initial browse load", async () => {
    const user = userEvent.setup();
    global.fetch = makeFetch();

    render(<SkillStorePanel />);

    await user.click(screen.getByRole("button", { name: "Browse" }));

    await waitFor(() => {
      expect(screen.getByText("Popular Skills")).toBeInTheDocument();
    });

    expect(screen.getByText("React Best Practices")).toBeInTheDocument();
    expect(screen.getByText("AI Image Generation")).toBeInTheDocument();
  });

  it("shows category pills on the browse tab", async () => {
    const user = userEvent.setup();
    global.fetch = makeFetch();

    render(<SkillStorePanel />);

    await user.click(screen.getByRole("button", { name: "Browse" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "React" })).toBeInTheDocument();
    });

    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "AI" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Python" })).toBeInTheDocument();
  });

  it("opens the detail drawer when clicking an installed skill", async () => {
    const user = userEvent.setup();
    global.fetch = makeFetch({ installedList: [installedSkill] });

    render(<SkillStorePanel />);

    await waitFor(() => {
      expect(screen.getAllByText("Next.js").length).toBeGreaterThan(0);
    });

    const cards = screen.getAllByRole("button").filter(
      (el) => el.getAttribute("aria-label") !== "Close" && el.textContent?.includes("Next.js"),
    );
    await user.click(cards[0]);

    await waitFor(() => {
      expect(screen.getByRole("dialog", { name: /Next\.js details/i })).toBeInTheDocument();
    });

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/# Skill Content/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
  });
});
