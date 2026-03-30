import type { WebhookContext } from "../../types.js";

export type TwimlResponseKind =
	| "empty"
	| "pause"
	| "queue"
	| "stored"
	| "stream";

export type TwimlRequestView = {
	callStatus: string | null;
	direction: string | null;
	isStatusCallback: boolean;
	callSid?: string;
	callIdFromQuery?: string;
};

export type TwimlPolicyInput = TwimlRequestView & {
	hasStoredTwiml: boolean;
	isNotifyCall: boolean;
	hasActiveStreams: boolean;
	canStream: boolean;
};

export type TwimlDecision =
	| {
			kind: "empty" | "pause" | "queue";
			consumeStoredTwimlCallId?: string;
			activateStreamCallSid?: string;
	  }
	| {
			kind: "stored";
			consumeStoredTwimlCallId: string;
			activateStreamCallSid?: string;
	  }
	| {
			kind: "stream";
			consumeStoredTwimlCallId?: string;
			activateStreamCallSid?: string;
	  };

function isOutboundDirection(direction: string | null): boolean {
	return direction?.startsWith("outbound") ?? false;
}

export function readTwimlRequestView(ctx: WebhookContext): TwimlRequestView {
	const params = new URLSearchParams(ctx.rawBody);
	const type =
		typeof ctx.query?.type === "string" ? ctx.query.type.trim() : undefined;
	const callIdFromQuery =
		typeof ctx.query?.callId === "string" && ctx.query.callId.trim()
			? ctx.query.callId.trim()
			: undefined;

	return {
		callStatus: params.get("CallStatus"),
		direction: params.get("Direction"),
		isStatusCallback: type === "status",
		callSid: params.get("CallSid") || undefined,
		callIdFromQuery,
	};
}

export function decideTwimlResponse(input: TwimlPolicyInput): TwimlDecision {
	if (input.callIdFromQuery && !input.isStatusCallback) {
		if (input.hasStoredTwiml) {
			return {
				kind: "stored",
				consumeStoredTwimlCallId: input.callIdFromQuery,
			};
		}
		if (input.isNotifyCall) {
			return { kind: "empty" };
		}

		if (isOutboundDirection(input.direction)) {
			return input.canStream ? { kind: "stream" } : { kind: "pause" };
		}
	}

	if (input.isStatusCallback) {
		return { kind: "empty" };
	}

	if (input.direction === "inbound") {
		if (input.hasActiveStreams) {
			return { kind: "queue" };
		}
		if (input.canStream && input.callSid) {
			return { kind: "stream", activateStreamCallSid: input.callSid };
		}
		return { kind: "pause" };
	}

	if (input.callStatus !== "in-progress") {
		return { kind: "empty" };
	}

	return input.canStream ? { kind: "stream" } : { kind: "pause" };
}
