"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getRefs = void 0;
const Options_1 = require("./Options.js");
const util_1 = require("./util.js");
const getRefs = (options) => {
    const _options = (0, Options_1.getDefaultOptions)(options);
    const currentPath = _options.name !== undefined ?
        [..._options.basePath, _options.definitionPath, _options.name]
        : _options.basePath;
    return {
        ..._options,
        currentPath: currentPath,
        propertyPath: undefined,
        seenRefs: new Set(),
        seen: new Map(Object.entries(_options.definitions).map(([name, def]) => [
            (0, util_1.zodDef)(def),
            {
                def: (0, util_1.zodDef)(def),
                path: [..._options.basePath, _options.definitionPath, name],
                // Resolution of references will be forced even though seen, so it's ok that the schema is undefined here for now.
                jsonSchema: undefined,
            },
        ])),
    };
};
exports.getRefs = getRefs;
//# sourceMappingURL=Refs.js.map