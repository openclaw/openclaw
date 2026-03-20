import {
	getActiveRun,
	startSubscribeRun,
	subscribeToRun,
	type SseEvent,
} from "@/lib/active-runs";

export const runtime = "nodejs";

export async function GET(req: Request) {
	const url = new URL(req.url);
	const sessionKey = url.searchParams.get("sessionKey");

	if (!sessionKey) {
		return new Response("sessionKey query parameter required", { status: 400 });
	}

	let run = getActiveRun(sessionKey);

	if (!run) {
		const sessionLabel = sessionKey.split(":").slice(2).join(":");
		run = startSubscribeRun({
			sessionKey,
			parentSessionId: sessionKey,
			task: `Channel session: ${sessionLabel}`,
			label: sessionLabel,
		});
	}

	if (!run) {
		return Response.json({ active: false }, { status: 404 });
	}

	const encoder = new TextEncoder();
	let closed = false;
	let unsubscribe: (() => void) | null = null;
	let keepalive: ReturnType<typeof setInterval> | null = null;

	const stream = new ReadableStream({
		start(controller) {
			keepalive = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(": keepalive\n\n"));
				} catch { /* ignore */ }
			}, 15_000);

			unsubscribe = subscribeToRun(
				sessionKey,
				(event: SseEvent | null) => {
					if (closed) return;
					if (event === null) {
						closed = true;
						if (keepalive) { clearInterval(keepalive); keepalive = null; }
						try { controller.close(); } catch { /* already closed */ }
						return;
					}
					try {
						const json = JSON.stringify(event);
						controller.enqueue(encoder.encode(`data: ${json}\n\n`));
					} catch { /* ignore */ }
				},
				{ replay: true },
			);

			if (!unsubscribe) {
				closed = true;
				if (keepalive) { clearInterval(keepalive); keepalive = null; }
				controller.close();
			}
		},
		cancel() {
			closed = true;
			if (keepalive) { clearInterval(keepalive); keepalive = null; }
			unsubscribe?.();
		},
	});

	return new Response(stream, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
			"X-Run-Active": run.status === "running" || run.status === "waiting-for-subagents" ? "true" : "false",
		},
	});
}
