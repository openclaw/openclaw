"use client";

import dynamic from "next/dynamic";
import type { UIMessage } from "ai";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChainOfThought, type ChainPart } from "./chain-of-thought";
import { splitReportBlocks, hasReportBlocks } from "@/lib/report-blocks";
import type { ReportConfig } from "./charts/types";

// Lazy-load ReportCard (uses Recharts which is heavy)
const ReportCard = dynamic(
	() =>
		import("./charts/report-card").then((m) => ({
			default: m.ReportCard,
		})),
	{
		ssr: false,
		loading: () => (
			<div
				className="h-48 rounded-2xl animate-pulse"
				style={{ background: "var(--color-surface-hover)" }}
			/>
		),
	},
);

/* ─── Part grouping ─── */

type MessageSegment =
	| { type: "text"; text: string }
	| { type: "chain"; parts: ChainPart[] }
	| { type: "report-artifact"; config: ReportConfig };

/** Map AI SDK tool state string to a simplified status */
function toolStatus(state: string): "running" | "done" | "error" {
	if (state === "output-available") {
		return "done";
	}
	if (state === "error") {
		return "error";
	}
	return "running";
}

/**
 * Group consecutive non-text parts (reasoning + tools) into chain-of-thought
 * blocks, with text parts standing alone between them.
 */
function groupParts(parts: UIMessage["parts"]): MessageSegment[] {
	const segments: MessageSegment[] = [];
	let chain: ChainPart[] = [];

	const flush = () => {
		if (chain.length > 0) {
			segments.push({ type: "chain", parts: [...chain] });
			chain = [];
		}
	};

	for (const part of parts) {
		if (part.type === "text") {
			flush();
			const text = (part as { type: "text"; text: string }).text;
			if (hasReportBlocks(text)) {
				segments.push(
					...(splitReportBlocks(text) as MessageSegment[]),
				);
			} else {
				segments.push({ type: "text", text });
			}
		} else if (part.type === "reasoning") {
			const rp = part as {
				type: "reasoning";
				text: string;
				state?: string;
			};
			// Detect status reasoning blocks emitted by lifecycle/compaction events.
			// These have short, specific labels — render as status indicators instead.
			const statusLabels = [
				"Preparing response...",
				"Optimizing session context...",
			];
			const isStatus = statusLabels.some((l) =>
				rp.text.startsWith(l),
			);
			if (isStatus) {
				chain.push({
					kind: "status",
					label: rp.text.split("\n")[0],
					isActive: rp.state === "streaming",
				});
			} else {
				chain.push({
					kind: "reasoning",
					text: rp.text,
					isStreaming: rp.state === "streaming",
				});
			}
		} else if (part.type === "dynamic-tool") {
			const tp = part as {
				type: "dynamic-tool";
				toolName: string;
				toolCallId: string;
				state: string;
				input?: unknown;
				output?: unknown;
			};
			chain.push({
				kind: "tool",
				toolName: tp.toolName,
				toolCallId: tp.toolCallId,
				status: toolStatus(tp.state),
				args: asRecord(tp.input),
				output: asRecord(tp.output),
			});
		} else if (part.type.startsWith("tool-")) {
			const tp = part as {
				type: string;
				toolCallId: string;
				toolName?: string;
				state?: string;
				title?: string;
				input?: unknown;
				output?: unknown;
			};
			chain.push({
				kind: "tool",
				toolName:
					tp.title ??
					tp.toolName ??
					part.type.replace("tool-", ""),
				toolCallId: tp.toolCallId,
				status: toolStatus(tp.state ?? "input-available"),
				args: asRecord(tp.input),
				output: asRecord(tp.output),
			});
		}
	}

	flush();
	return segments;
}

/** Safely cast unknown to Record if it's a non-null object */
function asRecord(
	val: unknown,
): Record<string, unknown> | undefined {
	if (val && typeof val === "object" && !Array.isArray(val)) {
		return val as Record<string, unknown>;
	}
	return undefined;
}

/* ─── Markdown component overrides for chat ─── */

const mdComponents: Components = {
	// Open external links in new tab
	a: ({ href, children, ...props }) => {
		const isExternal =
			href && (href.startsWith("http") || href.startsWith("//"));
		return (
			<a
				href={href}
				{...(isExternal
					? { target: "_blank", rel: "noopener noreferrer" }
					: {})}
				{...props}
			>
				{children}
			</a>
		);
	},
	// Render images with loading=lazy
	img: ({ src, alt, ...props }) => (
		// eslint-disable-next-line @next/next/no-img-element
		<img src={src} alt={alt ?? ""} loading="lazy" {...props} />
	),
};

/* ─── Chat message ─── */

export function ChatMessage({ message }: { message: UIMessage }) {
	const isUser = message.role === "user";
	const segments = groupParts(message.parts);

	if (isUser) {
		// User: right-aligned subtle pill
		const textContent = segments
			.filter(
				(s): s is { type: "text"; text: string } =>
					s.type === "text",
			)
			.map((s) => s.text)
			.join("\n");

		return (
			<div className="flex justify-end py-2">
				<div
					className="font-bookerly max-w-[80%] rounded-2xl rounded-br-sm px-4 py-2.5 text-[17px] leading-9"
					style={{
						background: "var(--color-user-bubble)",
						color: "var(--color-user-bubble-text)",
					}}
				>
					<p className="whitespace-pre-wrap">{textContent}</p>
				</div>
			</div>
		);
	}

	// Assistant: free-flowing text, left-aligned, NO bubble
	return (
		<div className="py-3 space-y-2">
			{segments.map((segment, index) => {
				if (segment.type === "text") {
					// Detect agent error messages
					const errorMatch = segment.text.match(
						/^\[error\]\s*([\s\S]*)$/,
					);
					if (errorMatch) {
						return (
							<div
								key={index}
								className="font-bookerly flex items-start gap-2 rounded-xl px-3 py-2 text-[13px] leading-relaxed"
								style={{
									background: `color-mix(in srgb, var(--color-error) 6%, var(--color-surface))`,
									color: "var(--color-error)",
									border: `1px solid color-mix(in srgb, var(--color-error) 18%, transparent)`,
								}}
							>
								<span
									className="flex-shrink-0 mt-0.5"
									aria-hidden="true"
								>
									<svg
										width="16"
										height="16"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<circle
											cx="12"
											cy="12"
											r="10"
										/>
										<line
											x1="12"
											y1="8"
											x2="12"
											y2="12"
										/>
										<line
											x1="12"
											y1="16"
											x2="12.01"
											y2="16"
										/>
									</svg>
								</span>
								<span className="whitespace-pre-wrap">
									{errorMatch[1].trim()}
								</span>
							</div>
						);
					}
				return (
			<div
				key={index}
				className="chat-prose font-bookerly text-[17px]"
				style={{ color: "var(--color-text)" }}
			>
				<ReactMarkdown
					remarkPlugins={[remarkGfm]}
					components={mdComponents}
				>
					{segment.text}
				</ReactMarkdown>
			</div>
				);
				}
				if (segment.type === "report-artifact") {
					return (
						<ReportCard
							key={index}
							config={segment.config}
						/>
					);
				}
				return (
					<ChainOfThought
						key={index}
						parts={segment.parts}
					/>
				);
			})}
		</div>
	);
}
