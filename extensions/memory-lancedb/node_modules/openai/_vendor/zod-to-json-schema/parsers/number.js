"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseNumberDef = parseNumberDef;
const errorMessages_1 = require("../errorMessages.js");
function parseNumberDef(def, refs) {
    const res = {
        type: 'number',
    };
    if (!def.checks)
        return res;
    for (const check of def.checks) {
        switch (check.kind) {
            case 'int':
                res.type = 'integer';
                (0, errorMessages_1.addErrorMessage)(res, 'type', check.message, refs);
                break;
            case 'min':
                if (refs.target === 'jsonSchema7') {
                    if (check.inclusive) {
                        (0, errorMessages_1.setResponseValueAndErrors)(res, 'minimum', check.value, check.message, refs);
                    }
                    else {
                        (0, errorMessages_1.setResponseValueAndErrors)(res, 'exclusiveMinimum', check.value, check.message, refs);
                    }
                }
                else {
                    if (!check.inclusive) {
                        res.exclusiveMinimum = true;
                    }
                    (0, errorMessages_1.setResponseValueAndErrors)(res, 'minimum', check.value, check.message, refs);
                }
                break;
            case 'max':
                if (refs.target === 'jsonSchema7') {
                    if (check.inclusive) {
                        (0, errorMessages_1.setResponseValueAndErrors)(res, 'maximum', check.value, check.message, refs);
                    }
                    else {
                        (0, errorMessages_1.setResponseValueAndErrors)(res, 'exclusiveMaximum', check.value, check.message, refs);
                    }
                }
                else {
                    if (!check.inclusive) {
                        res.exclusiveMaximum = true;
                    }
                    (0, errorMessages_1.setResponseValueAndErrors)(res, 'maximum', check.value, check.message, refs);
                }
                break;
            case 'multipleOf':
                (0, errorMessages_1.setResponseValueAndErrors)(res, 'multipleOf', check.value, check.message, refs);
                break;
        }
    }
    return res;
}
//# sourceMappingURL=number.js.map