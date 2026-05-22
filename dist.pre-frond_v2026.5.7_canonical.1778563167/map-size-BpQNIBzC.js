//#region src/infra/map-size.ts
function pruneMapToMaxSize(map, maxSize) {
	const limit = Math.max(0, Math.floor(maxSize));
	if (limit <= 0) {
		map.clear();
		return;
	}
	while (map.size > limit) {
		const oldest = map.keys().next();
		if (oldest.done) break;
		map.delete(oldest.value);
	}
}
//#endregion
export { pruneMapToMaxSize as t };
