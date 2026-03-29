import { getDefaultOptions } from "./Options.mjs";
import { zodDef } from "./util.mjs";
export const getRefs = (options) => {
    const _options = getDefaultOptions(options);
    const currentPath = _options.name !== undefined ?
        [..._options.basePath, _options.definitionPath, _options.name]
        : _options.basePath;
    return {
        ..._options,
        currentPath: currentPath,
        propertyPath: undefined,
        seenRefs: new Set(),
        seen: new Map(Object.entries(_options.definitions).map(([name, def]) => [
            zodDef(def),
            {
                def: zodDef(def),
                path: [..._options.basePath, _options.definitionPath, name],
                // Resolution of references will be forced even though seen, so it's ok that the schema is undefined here for now.
                jsonSchema: undefined,
            },
        ])),
    };
};
//# sourceMappingURL=Refs.mjs.map