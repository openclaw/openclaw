// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { IntegrationsPanel } from "./integrations-panel";

describe("IntegrationsPanel", () => {
  it("renders the integrations heading", () => {
    render(<IntegrationsPanel />);

    expect(screen.getByRole("heading", { name: "Integrations" })).toBeInTheDocument();
    expect(
      screen.getByText("Manage Dench-managed integrations and search ownership in one place."),
    ).toBeInTheDocument();
  });
});
