"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.addErrorMessage = addErrorMessage;
exports.setResponseValueAndErrors = setResponseValueAndErrors;
function addErrorMessage(res, key, errorMessage, refs) {
    if (!refs?.errorMessages)
        return;
    if (errorMessage) {
        res.errorMessage = {
            ...res.errorMessage,
            [key]: errorMessage,
        };
    }
}
function setResponseValueAndErrors(res, key, value, errorMessage, refs) {
    res[key] = value;
    addErrorMessage(res, key, errorMessage, refs);
}
//# sourceMappingURL=errorMessages.js.map