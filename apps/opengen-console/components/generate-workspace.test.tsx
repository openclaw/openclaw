/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { GenerateWorkspace } from "./generate-workspace";

describe("generate workspace", () => {
  it("shows loading and then renders result sections", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        outputs: {
          product_spec: { user_stories: [], features: [], non_functional_requirements: {} },
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    render(<GenerateWorkspace />);
    fireEvent.change(screen.getByLabelText("需求描述"), { target: { value: "todo app" } });
    fireEvent.click(screen.getByRole("button", { name: "开始生成" }));

    expect(await screen.findByText("用户故事")).toBeInTheDocument();
  });
});
