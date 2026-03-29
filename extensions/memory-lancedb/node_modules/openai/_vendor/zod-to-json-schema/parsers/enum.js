"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseEnumDef = parseEnumDef;
function parseEnumDef(def) {
    return {
        type: 'string',
        enum: [...def.values],
    };
}
//# sourceMappingURL=enum.js.map