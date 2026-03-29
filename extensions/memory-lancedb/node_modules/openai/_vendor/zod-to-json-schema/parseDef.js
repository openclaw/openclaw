"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseDef = parseDef;
const v3_1 = require("zod/v3");
const any_1 = require("./parsers/any.js");
const array_1 = require("./parsers/array.js");
const bigint_1 = require("./parsers/bigint.js");
const boolean_1 = require("./parsers/boolean.js");
const branded_1 = require("./parsers/branded.js");
const catch_1 = require("./parsers/catch.js");
const date_1 = require("./parsers/date.js");
const default_1 = require("./parsers/default.js");
const effects_1 = require("./parsers/effects.js");
const enum_1 = require("./parsers/enum.js");
const intersection_1 = require("./parsers/intersection.js");
const literal_1 = require("./parsers/literal.js");
const map_1 = require("./parsers/map.js");
const nativeEnum_1 = require("./parsers/nativeEnum.js");
const never_1 = require("./parsers/never.js");
const null_1 = require("./parsers/null.js");
const nullable_1 = require("./parsers/nullable.js");
const number_1 = require("./parsers/number.js");
const object_1 = require("./parsers/object.js");
const optional_1 = require("./parsers/optional.js");
const pipeline_1 = require("./parsers/pipeline.js");
const promise_1 = require("./parsers/promise.js");
const record_1 = require("./parsers/record.js");
const set_1 = require("./parsers/set.js");
const string_1 = require("./parsers/string.js");
const tuple_1 = require("./parsers/tuple.js");
const undefined_1 = require("./parsers/undefined.js");
const union_1 = require("./parsers/union.js");
const unknown_1 = require("./parsers/unknown.js");
const readonly_1 = require("./parsers/readonly.js");
const Options_1 = require("./Options.js");
function parseDef(def, refs, forceResolution = false) {
    const seenItem = refs.seen.get(def);
    if (refs.override) {
        const overrideResult = refs.override?.(def, refs, seenItem, forceResolution);
        if (overrideResult !== Options_1.ignoreOverride) {
            return overrideResult;
        }
    }
    if (seenItem && !forceResolution) {
        const seenSchema = get$ref(seenItem, refs);
        if (seenSchema !== undefined) {
            if ('$ref' in seenSchema) {
                refs.seenRefs.add(seenSchema.$ref);
            }
            return seenSchema;
        }
    }
    const newItem = { def, path: refs.currentPath, jsonSchema: undefined };
    refs.seen.set(def, newItem);
    const jsonSchema = selectParser(def, def.typeName, refs, forceResolution);
    if (jsonSchema) {
        addMeta(def, refs, jsonSchema);
    }
    newItem.jsonSchema = jsonSchema;
    return jsonSchema;
}
const get$ref = (item, refs) => {
    switch (refs.$refStrategy) {
        case 'root':
            return { $ref: item.path.join('/') };
        // this case is needed as OpenAI strict mode doesn't support top-level `$ref`s, i.e.
        // the top-level schema *must* be `{"type": "object", "properties": {...}}` but if we ever
        // need to define a `$ref`, relative `$ref`s aren't supported, so we need to extract
        // the schema to `#/definitions/` and reference that.
        //
        // e.g. if we need to reference a schema at
        // `["#","definitions","contactPerson","properties","person1","properties","name"]`
        // then we'll extract it out to `contactPerson_properties_person1_properties_name`
        case 'extract-to-root':
            const name = item.path.slice(refs.basePath.length + 1).join('_');
            // we don't need to extract the root schema in this case, as it's already
            // been added to the definitions
            if (name !== refs.name && refs.nameStrategy === 'duplicate-ref') {
                refs.definitions[name] = item.def;
            }
            return { $ref: [...refs.basePath, refs.definitionPath, name].join('/') };
        case 'relative':
            return { $ref: getRelativePath(refs.currentPath, item.path) };
        case 'none':
        case 'seen': {
            if (item.path.length < refs.currentPath.length &&
                item.path.every((value, index) => refs.currentPath[index] === value)) {
                console.warn(`Recursive reference detected at ${refs.currentPath.join('/')}! Defaulting to any`);
                return {};
            }
            return refs.$refStrategy === 'seen' ? {} : undefined;
        }
    }
};
const getRelativePath = (pathA, pathB) => {
    let i = 0;
    for (; i < pathA.length && i < pathB.length; i++) {
        if (pathA[i] !== pathB[i])
            break;
    }
    return [(pathA.length - i).toString(), ...pathB.slice(i)].join('/');
};
const selectParser = (def, typeName, refs, forceResolution) => {
    switch (typeName) {
        case v3_1.ZodFirstPartyTypeKind.ZodString:
            return (0, string_1.parseStringDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodNumber:
            return (0, number_1.parseNumberDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodObject:
            return (0, object_1.parseObjectDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodBigInt:
            return (0, bigint_1.parseBigintDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodBoolean:
            return (0, boolean_1.parseBooleanDef)();
        case v3_1.ZodFirstPartyTypeKind.ZodDate:
            return (0, date_1.parseDateDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodUndefined:
            return (0, undefined_1.parseUndefinedDef)();
        case v3_1.ZodFirstPartyTypeKind.ZodNull:
            return (0, null_1.parseNullDef)(refs);
        case v3_1.ZodFirstPartyTypeKind.ZodArray:
            return (0, array_1.parseArrayDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodUnion:
        case v3_1.ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
            return (0, union_1.parseUnionDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodIntersection:
            return (0, intersection_1.parseIntersectionDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodTuple:
            return (0, tuple_1.parseTupleDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodRecord:
            return (0, record_1.parseRecordDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodLiteral:
            return (0, literal_1.parseLiteralDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodEnum:
            return (0, enum_1.parseEnumDef)(def);
        case v3_1.ZodFirstPartyTypeKind.ZodNativeEnum:
            return (0, nativeEnum_1.parseNativeEnumDef)(def);
        case v3_1.ZodFirstPartyTypeKind.ZodNullable:
            return (0, nullable_1.parseNullableDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodOptional:
            return (0, optional_1.parseOptionalDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodMap:
            return (0, map_1.parseMapDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodSet:
            return (0, set_1.parseSetDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodLazy:
            return parseDef(def.getter()._def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodPromise:
            return (0, promise_1.parsePromiseDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodNaN:
        case v3_1.ZodFirstPartyTypeKind.ZodNever:
            return (0, never_1.parseNeverDef)();
        case v3_1.ZodFirstPartyTypeKind.ZodEffects:
            return (0, effects_1.parseEffectsDef)(def, refs, forceResolution);
        case v3_1.ZodFirstPartyTypeKind.ZodAny:
            return (0, any_1.parseAnyDef)();
        case v3_1.ZodFirstPartyTypeKind.ZodUnknown:
            return (0, unknown_1.parseUnknownDef)();
        case v3_1.ZodFirstPartyTypeKind.ZodDefault:
            return (0, default_1.parseDefaultDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodBranded:
            return (0, branded_1.parseBrandedDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodReadonly:
            return (0, readonly_1.parseReadonlyDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodCatch:
            return (0, catch_1.parseCatchDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodPipeline:
            return (0, pipeline_1.parsePipelineDef)(def, refs);
        case v3_1.ZodFirstPartyTypeKind.ZodFunction:
        case v3_1.ZodFirstPartyTypeKind.ZodVoid:
        case v3_1.ZodFirstPartyTypeKind.ZodSymbol:
            return undefined;
        default:
            return ((_) => undefined)(typeName);
    }
};
const addMeta = (def, refs, jsonSchema) => {
    if (def.description) {
        jsonSchema.description = def.description;
        if (refs.markdownDescription) {
            jsonSchema.markdownDescription = def.description;
        }
    }
    return jsonSchema;
};
//# sourceMappingURL=parseDef.js.map