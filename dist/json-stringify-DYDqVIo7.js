//#region node_modules/@openclaw/fs-safe/dist/json-stringify.js
function stringifyJsonDocument(value, replacer, space) {
	const text = JSON.stringify(value, replacer, space);
	if (typeof text !== "string") throw new TypeError("value is not representable as a JSON document");
	return text;
}
//#endregion
export { stringifyJsonDocument as t };
