//#region src/channels/message/live.ts
function defineFinalizableLivePreviewAdapter(adapter) {
	return adapter;
}
function createLiveMessageState(params) {
	return {
		phase: params?.receipt ? "previewing" : "idle",
		canFinalizeInPlace: params?.canFinalizeInPlace ?? Boolean(params?.receipt),
		...params?.receipt ? { receipt: params.receipt } : {},
		...params?.lastRendered ? { lastRendered: params.lastRendered } : {}
	};
}
function markLiveMessageFinalized(state, receipt) {
	return {
		...state,
		phase: "finalized",
		receipt,
		canFinalizeInPlace: false
	};
}
function createPreviewMessageReceipt(params) {
	const platformMessageId = String(params.id);
	return {
		primaryPlatformMessageId: platformMessageId,
		platformMessageIds: [platformMessageId],
		parts: [{
			platformMessageId,
			kind: "preview",
			index: 0,
			...params.threadId ? { threadId: params.threadId } : {},
			...params.replyToId ? { replyToId: params.replyToId } : {}
		}],
		...params.threadId ? { threadId: params.threadId } : {},
		...params.replyToId ? { replyToId: params.replyToId } : {},
		sentAt: params.sentAt ?? Date.now(),
		...params.raw === void 0 ? {} : { raw: [{ meta: { raw: params.raw } }] }
	};
}
async function deliverFinalizableLivePreview(params) {
	let liveState = params.liveState ?? createLiveMessageState({ canFinalizeInPlace: Boolean(params.draft) });
	if (params.kind !== "final" || !params.draft) {
		if (await params.deliverNormally(params.payload) === false) return {
			kind: "normal-skipped",
			liveState
		};
		await params.onNormalDelivered?.();
		return {
			kind: "normal-delivered",
			liveState
		};
	}
	const edit = liveState.canFinalizeInPlace ? params.buildFinalEdit(params.payload) : void 0;
	if (edit !== void 0) {
		await params.draft.flush();
		const previewId = params.draft.id();
		if (previewId !== void 0) {
			await params.draft.seal?.();
			let editSucceeded = false;
			try {
				await params.editFinal(previewId, edit);
				editSucceeded = true;
			} catch (err) {
				params.logPreviewEditFailure?.(err);
				if ((await params.handlePreviewEditError?.({
					error: err,
					id: previewId,
					edit,
					payload: params.payload,
					liveState
				}) ?? "fallback") === "retain") {
					const receipt = liveState.receipt ?? params.createPreviewReceipt?.(previewId, edit) ?? createPreviewMessageReceipt({ id: previewId });
					liveState = {
						...liveState,
						phase: "previewing",
						canFinalizeInPlace: true,
						receipt
					};
					return {
						kind: "preview-retained",
						liveState
					};
				}
			}
			if (editSucceeded) {
				const finalizedId = params.resolveFinalizedId?.(previewId, edit) ?? previewId;
				const receipt = params.createPreviewReceipt?.(finalizedId, edit) ?? createPreviewMessageReceipt({ id: finalizedId });
				liveState = markLiveMessageFinalized(liveState, receipt);
				await params.onPreviewFinalized?.(finalizedId, receipt, liveState);
				const supplementalPayload = params.buildSupplementalPayload?.(params.payload);
				if (supplementalPayload !== void 0) await params.deliverSupplemental?.(supplementalPayload);
				return {
					kind: "preview-finalized",
					liveState
				};
			}
		}
	}
	if (params.draft.discardPending) await params.draft.discardPending();
	else await params.draft.clear();
	liveState = markLiveMessageCancelled(liveState);
	let delivered = false;
	try {
		delivered = await params.deliverNormally(params.payload) !== false;
		if (delivered) await params.onNormalDelivered?.();
	} finally {
		if (delivered) await params.draft.clear();
	}
	return {
		kind: delivered ? "normal-delivered" : "normal-skipped",
		liveState
	};
}
async function deliverWithFinalizableLivePreviewAdapter(params) {
	if (!params.adapter) {
		const liveState = params.liveState ?? createLiveMessageState();
		if (await params.deliverNormally(params.payload) === false) return {
			kind: "normal-skipped",
			liveState
		};
		await params.onNormalDelivered?.();
		return {
			kind: "normal-delivered",
			liveState
		};
	}
	return await deliverFinalizableLivePreview({
		kind: params.kind,
		payload: params.payload,
		...params.liveState ? { liveState: params.liveState } : {},
		draft: params.adapter.draft,
		buildFinalEdit: params.adapter.buildFinalEdit,
		editFinal: params.adapter.editFinal,
		...params.adapter.resolveFinalizedId ? { resolveFinalizedId: params.adapter.resolveFinalizedId } : {},
		deliverNormally: params.deliverNormally,
		...params.adapter.createPreviewReceipt ? { createPreviewReceipt: params.adapter.createPreviewReceipt } : {},
		...params.adapter.onPreviewFinalized ? { onPreviewFinalized: params.adapter.onPreviewFinalized } : {},
		...params.adapter.buildSupplementalPayload ? { buildSupplementalPayload: params.adapter.buildSupplementalPayload } : {},
		...params.adapter.deliverSupplemental ? { deliverSupplemental: params.adapter.deliverSupplemental } : {},
		...params.adapter.handlePreviewEditError ? { handlePreviewEditError: params.adapter.handlePreviewEditError } : {},
		...params.onNormalDelivered ? { onNormalDelivered: params.onNormalDelivered } : {},
		...params.adapter.logPreviewEditFailure ? { logPreviewEditFailure: params.adapter.logPreviewEditFailure } : {}
	});
}
function markLiveMessagePreviewUpdated(state, rendered) {
	return {
		...state,
		phase: "previewing",
		lastRendered: rendered
	};
}
function markLiveMessageCancelled(state) {
	return {
		...state,
		phase: "cancelled",
		canFinalizeInPlace: false
	};
}
//#endregion
export { deliverWithFinalizableLivePreviewAdapter as a, markLiveMessagePreviewUpdated as c, deliverFinalizableLivePreview as i, createPreviewMessageReceipt as n, markLiveMessageCancelled as o, defineFinalizableLivePreviewAdapter as r, markLiveMessageFinalized as s, createLiveMessageState as t };
