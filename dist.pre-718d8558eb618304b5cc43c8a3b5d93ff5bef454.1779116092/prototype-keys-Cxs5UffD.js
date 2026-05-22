//#region src/infra/prototype-keys.ts
const BLOCKED_OBJECT_KEYS = new Set([
	"__proto__",
	"prototype",
	"constructor"
]);
function isBlockedObjectKey(key) {
	return BLOCKED_OBJECT_KEYS.has(key);
}
//#endregion
export { isBlockedObjectKey as t };
