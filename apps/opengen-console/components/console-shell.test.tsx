/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { ConsoleShell } from "./console-shell";

describe("console shell", () => {
  it("renders primary navigation", () => {
    render(<ConsoleShell title="Overview">x</ConsoleShell>);
    expect(screen.getByRole("link", { name: "Overview" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Generate" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toBeInTheDocument();
  });
});
