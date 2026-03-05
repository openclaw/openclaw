/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConsoleShell } from "./console-shell";

describe("console shell", () => {
  it("renders primary navigation", () => {
    render(<ConsoleShell title="总览">x</ConsoleShell>);
    expect(screen.getByRole("link", { name: "总览" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "生成" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "任务" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "设置" })).toBeInTheDocument();
  });
});
