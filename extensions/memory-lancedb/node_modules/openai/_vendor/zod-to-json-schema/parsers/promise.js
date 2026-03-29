"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parsePromiseDef = parsePromiseDef;
const parseDef_1 = require("../parseDef.js");
function parsePromiseDef(def, refs) {
    return (0, parseDef_1.parseDef)(def.type._def, refs);
}
//# sourceMappingURL=promise.js.map