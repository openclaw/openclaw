//#region src/flows/doctor-error-message.ts
const ERR_MESSAGE_MAX_LEN = 256;
function scrubDoctorErrorMessage(err) {
	const raw = err instanceof Error ? err.message : String(err);
	let stripped = "";
	for (let index = 0; index < raw.length; index++) {
		const code = raw.charCodeAt(index);
		if (code > 31 && code !== 127) stripped += raw.charAt(index);
	}
	if (stripped.length <= ERR_MESSAGE_MAX_LEN) return stripped;
	return `${stripped.slice(0, ERR_MESSAGE_MAX_LEN - 3)}...`;
}
//#endregion
export { scrubDoctorErrorMessage as t };
