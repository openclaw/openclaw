// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProfileSwitcher } from "./profile-switcher";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ProfileSwitcher workspace delete action", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes a workspace from the dropdown action", async () => {
    const user = userEvent.setup();
    const onWorkspaceDelete = vi.fn();
    let listFetchCount = 0;

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL).href;
      const method = init?.method ?? "GET";
      if (url === "/api/workspace/list" && method === "GET") {
        listFetchCount += 1;
        if (listFetchCount === 1) {
          return jsonResponse({
            activeWorkspace: "work",
            workspaces: [
              {
                name: "work",
                stateDir: "/home/testuser/.openclaw-work",
                workspaceDir: "/home/testuser/.openclaw-work/workspace",
                isActive: true,
                hasConfig: true,
              },
            ],
          });
        }
        return jsonResponse({
          activeWorkspace: "work",
          workspaces: [
            {
              name: "work",
              stateDir: "/home/testuser/.openclaw-work",
              workspaceDir: null,
              isActive: true,
              hasConfig: true,
            },
          ],
        });
      }
      if (url === "/api/workspace/delete" && method === "POST") {
        return jsonResponse({ deleted: true, workspace: "work" });
      }
      throw new Error(`Unexpected fetch call: ${method} ${url}`);
    }) as typeof fetch;

    render(<ProfileSwitcher onWorkspaceDelete={onWorkspaceDelete} />);
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/workspace/list");
    });

    await user.click(screen.getByTitle("Switch workspace"));

    const trigger = document.querySelector("[data-slot='dropdown-menu-trigger']");
    expect(trigger).toBeTruthy();
    await user.click(trigger as HTMLElement);

    await waitFor(() => {
      expect(screen.getByText("Delete")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Delete"));

    await waitFor(() => {
      expect(screen.getByText("Delete workspace")).toBeInTheDocument();
    });
    const confirmBtn = screen.getAllByText("Delete").find(
      (el) => el.tagName === "BUTTON" && el.closest("[data-slot='dialog-content']"),
    );
    expect(confirmBtn).toBeTruthy();
    await user.click(confirmBtn as HTMLElement);

    await waitFor(() => {
      expect(onWorkspaceDelete).toHaveBeenCalledWith("work");
    });

    const deleteCall = vi
      .mocked(global.fetch)
      .mock.calls.find((call) => (typeof call[0] === "string" ? call[0] : (call[0] as URL).href) === "/api/workspace/delete");
    expect(deleteCall).toBeTruthy();
    const deleteBody = JSON.parse(deleteCall?.[1]?.body as string);
    expect(deleteBody).toMatchObject({ workspace: "work" });
  });

  it("falls back to a real workspace when API returns stale active workspace", async () => {
    const user = userEvent.setup();

    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : (input as URL).href;
      const method = init?.method ?? "GET";
      if (url === "/api/workspace/list" && method === "GET") {
        return jsonResponse({
          activeWorkspace: "ghost",
          workspaces: [
            {
              name: "ghost",
              stateDir: "/home/testuser/.openclaw-dench",
              workspaceDir: null,
              isActive: true,
              hasConfig: true,
            },
            {
              name: "dench",
              stateDir: "/home/testuser/.openclaw-dench",
              workspaceDir: "/home/testuser/.openclaw-dench/workspace",
              isActive: false,
              hasConfig: true,
            },
          ],
        });
      }
      throw new Error(`Unexpected fetch call: ${method} ${url}`);
    }) as typeof fetch;

    render(<ProfileSwitcher />);

    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalledWith("/api/workspace/list");
    });

    await user.click(screen.getByTitle("Switch workspace"));

    await waitFor(() => {
      const allDench = screen.getAllByText("dench");
      expect(allDench.length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText("ghost")).not.toBeInTheDocument();
    });

    const triggers = document.querySelectorAll("[data-slot='dropdown-menu-trigger']");
    expect(triggers.length).toBe(1);
  });
});
