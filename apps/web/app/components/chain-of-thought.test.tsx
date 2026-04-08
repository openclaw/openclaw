// @vitest-environment jsdom
import React from "react";
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ChainOfThought, type ChainPart } from "./chain-of-thought";
import { denchIntegrationsBrand } from "@/lib/dench-integrations-brand";

describe("ChainOfThought image steps", () => {
	it("treats image-file tools as reads instead of image generation", () => {
		const parts: ChainPart[] = [
			{
				kind: "tool",
				toolName: "image",
				toolCallId: "tool-1",
				status: "done",
				args: { path: "/tmp/photo.png" },
			},
		];

		render(<ChainOfThought parts={parts} isStreaming />);

		expect(screen.getByText("Read 1 image")).toBeTruthy();
		expect(screen.getByRole("img", { name: "photo.png" })).toBeTruthy();
		expect(screen.queryByText(/Generating image/i)).toBeNull();
	});

	it("keeps generation labels for prompt-based image tools", () => {
		const parts: ChainPart[] = [
			{
				kind: "tool",
				toolName: "image",
				toolCallId: "tool-1",
				status: "running",
				args: { description: "a cat wearing sunglasses" },
			},
		];

		render(<ChainOfThought parts={parts} isStreaming />);

		expect(
			screen.getByText("Generating image: a cat wearing sunglasses"),
		).toBeTruthy();
	});
});

describe("ChainOfThought integration steps", () => {
	it("renders a Dench Integrations search label with schema details", () => {
		const parts: ChainPart[] = [
			{
				kind: "tool",
				toolName: "composio_search_tools",
				toolCallId: "tool-search-1",
				status: "done",
				args: {
					query: "list Stripe subscriptions",
				},
				output: {
					search_session_id: "trs_123",
					results: [
						{
							tool: "STRIPE_LIST_SUBSCRIPTIONS",
						},
					],
					recommended_result: {
						account_candidates: [
							{ display_label: "Primary Stripe" },
						],
						input_schema: {
							type: "object",
							required: ["limit"],
							properties: {
								limit: { type: "number" },
								starting_after: { type: "string" },
							},
						},
						recommended_plan_steps: [
							"List subscriptions.",
							"Continue while has_more is true.",
						],
						known_pitfalls: [
							"Do not stop after the first page.",
						],
					},
				},
			},
		];

		render(<ChainOfThought parts={parts} isStreaming={false} />);
		fireEvent.click(screen.getByRole("button", { name: /thought/i }));

		expect(screen.getByText(denchIntegrationsBrand.searchLabel)).toBeTruthy();
		expect(screen.queryByText("Searching Composio tools")).toBeNull();
		expect(screen.getByText(/Top matches:/i)).toBeTruthy();
		expect(screen.getByText(/STRIPE_LIST_SUBSCRIPTIONS/)).toBeTruthy();
		expect(screen.getByText(/Schema:/i)).toBeTruthy();
		expect(screen.getByText(/2 input fields, 1 required/)).toBeTruthy();
		expect(screen.getByText(/Session:/i)).toBeTruthy();
		expect(screen.getByText("trs_123")).toBeTruthy();
		expect(screen.getByText("Schema details")).toBeTruthy();
	});

	it("renders a Dench Integration execution label with pagination summary", () => {
		const parts: ChainPart[] = [
			{
				kind: "tool",
				toolName: "composio_call_tool",
				toolCallId: "tool-call-1",
				status: "done",
				args: {
					app: "stripe",
					tool_name: "STRIPE_LIST_SUBSCRIPTIONS",
					account: "acct_primary",
					arguments: {
						limit: 100,
						starting_after: "sub_prev",
					},
				},
				output: {
					has_more: true,
					next_cursor: "sub_next",
					data: [{ id: "sub_123" }],
				},
			},
		];

		render(<ChainOfThought parts={parts} isStreaming={false} />);
		fireEvent.click(screen.getByRole("button", { name: /thought/i }));

		expect(screen.getByText(denchIntegrationsBrand.callLabel)).toBeTruthy();
		expect(screen.queryByText("Calling Composio tool")).toBeNull();
		expect(screen.getByText(/Tool:/i)).toBeTruthy();
		expect(screen.getByText(/stripe \/ STRIPE_LIST_SUBSCRIPTIONS/)).toBeTruthy();
		expect(screen.getAllByText(/Account:/i).length).toBeGreaterThan(0);
		expect(screen.getByText("acct_primary")).toBeTruthy();
		expect(screen.getByText(/Pagination:/i)).toBeTruthy();
		expect(screen.getByText(/has_more: true \| next_cursor: sub_next/)).toBeTruthy();
		expect(screen.getByText(/Result:/i)).toBeTruthy();
		expect(screen.getByText("1 result")).toBeTruthy();
	});
});
