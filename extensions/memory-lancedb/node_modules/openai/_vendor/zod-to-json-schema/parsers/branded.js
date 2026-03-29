"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseBrandedDef = parseBrandedDef;
const parseDef_1 = require("../parseDef.js");
function parseBrandedDef(_def, refs) {
    return (0, parseDef_1.parseDef)(_def.type._def, refs);
}
//# sourceMappingURL=branded.js.map