import {
	startSubscribeRun,
	getActiveRun,
	subscribeToRun,
	reactivateSubscribeRun,
	type SseEvent,
} from "@/lib/active-runs";

export const runtime = "nodejs";

export async function POST(req: Request) {
	const { sessionKey, message }: { sessionKey: string; message: string } = await req.json();

	if (!sessionKey || !message?.trim()) {
		return new Response("sessionKey and message are required", { status: 400 });
	}

	let run = getActiveRun(sessionKey);
	if (run?.status === "running") {
		return new Response("Active run already in progress for this session", { status: 409 });
	}

	if (run) {
		reactivateSubscribeRun(sessionKey, message);
	} else {
		const sessionLabel = sessionKey.split(":").slice(2).join(":");
		run = startSubscribeRun({
			sessionKey,
			parentSessionId: sessionKey,
			task: message.slice(0, 200),
			label: sessionLabel,
		});
		reactivateSubscribeRun(sessionKey, message);
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
				{ replay: false },
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
		},
	});
}
