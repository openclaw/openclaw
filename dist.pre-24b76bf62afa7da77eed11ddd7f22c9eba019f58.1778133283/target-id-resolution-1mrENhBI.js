import { r as maybeResolvePluginMessagingTarget } from "./target-normalization-MVno0zPr.js";
//#region src/infra/outbound/target-id-resolution.ts
async function maybeResolveIdLikeTarget(params) {
	const target = await maybeResolvePluginMessagingTarget({
		...params,
		requireIdLike: true
	});
	if (!target) return;
	return target;
}
//#endregion
export { maybeResolveIdLikeTarget as t };
