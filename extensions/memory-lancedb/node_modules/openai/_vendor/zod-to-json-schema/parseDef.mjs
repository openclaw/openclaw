import { ZodFirstPartyTypeKind } from 'zod/v3';
import { parseAnyDef } from "./parsers/any.mjs";
import { parseArrayDef } from "./parsers/array.mjs";
import { parseBigintDef } from "./parsers/bigint.mjs";
import { parseBooleanDef } from "./parsers/boolean.mjs";
import { parseBrandedDef } from "./parsers/branded.mjs";
import { parseCatchDef } from "./parsers/catch.mjs";
import { parseDateDef } from "./parsers/date.mjs";
import { parseDefaultDef } from "./parsers/default.mjs";
import { parseEffectsDef } from "./parsers/effects.mjs";
import { parseEnumDef } from "./parsers/enum.mjs";
import { parseIntersectionDef } from "./parsers/intersection.mjs";
import { parseLiteralDef } from "./parsers/literal.mjs";
import { parseMapDef } from "./parsers/map.mjs";
import { parseNativeEnumDef } from "./parsers/nativeEnum.mjs";
import { parseNeverDef } from "./parsers/never.mjs";
import { parseNullDef } from "./parsers/null.mjs";
import { parseNullableDef } from "./parsers/nullable.mjs";
import { parseNumberDef } from "./parsers/number.mjs";
import { parseObjectDef } from "./parsers/object.mjs";
import { parseOptionalDef } from "./parsers/optional.mjs";
import { parsePipelineDef } from "./parsers/pipeline.mjs";
import { parsePromiseDef } from "./parsers/promise.mjs";
import { parseRecordDef } from "./parsers/record.mjs";
import { parseSetDef } from "./parsers/set.mjs";
import { parseStringDef } from "./parsers/string.mjs";
import { parseTupleDef } from "./parsers/tuple.mjs";
import { parseUndefinedDef } from "./parsers/undefined.mjs";
import { parseUnionDef } from "./parsers/union.mjs";
import { parseUnknownDef } from "./parsers/unknown.mjs";
import { parseReadonlyDef } from "./parsers/readonly.mjs";
import { ignoreOverride } from "./Options.mjs";
export function parseDef(def, refs, forceResolution = false) {
    const seenItem = refs.seen.get(def);
    if (refs.override) {
        const overrideResult = refs.override?.(def, refs, seenItem, forceResolution);
        if (overrideResult !== ignoreOverride) {
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
        case ZodFirstPartyTypeKind.ZodString:
            return parseStringDef(def, refs);
        case ZodFirstPartyTypeKind.ZodNumber:
            return parseNumberDef(def, refs);
        case ZodFirstPartyTypeKind.ZodObject:
            return parseObjectDef(def, refs);
        case ZodFirstPartyTypeKind.ZodBigInt:
            return parseBigintDef(def, refs);
        case ZodFirstPartyTypeKind.ZodBoolean:
            return parseBooleanDef();
        case ZodFirstPartyTypeKind.ZodDate:
            return parseDateDef(def, refs);
        case ZodFirstPartyTypeKind.ZodUndefined:
            return parseUndefinedDef();
        case ZodFirstPartyTypeKind.ZodNull:
            return parseNullDef(refs);
        case ZodFirstPartyTypeKind.ZodArray:
            return parseArrayDef(def, refs);
        case ZodFirstPartyTypeKind.ZodUnion:
        case ZodFirstPartyTypeKind.ZodDiscriminatedUnion:
            return parseUnionDef(def, refs);
        case ZodFirstPartyTypeKind.ZodIntersection:
            return parseIntersectionDef(def, refs);
        case ZodFirstPartyTypeKind.ZodTuple:
            return parseTupleDef(def, refs);
        case ZodFirstPartyTypeKind.ZodRecord:
            return parseRecordDef(def, refs);
        case ZodFirstPartyTypeKind.ZodLiteral:
            return parseLiteralDef(def, refs);
        case ZodFirstPartyTypeKind.ZodEnum:
            return parseEnumDef(def);
        case ZodFirstPartyTypeKind.ZodNativeEnum:
            return parseNativeEnumDef(def);
        case ZodFirstPartyTypeKind.ZodNullable:
            return parseNullableDef(def, refs);
        case ZodFirstPartyTypeKind.ZodOptional:
            return parseOptionalDef(def, refs);
        case ZodFirstPartyTypeKind.ZodMap:
            return parseMapDef(def, refs);
        case ZodFirstPartyTypeKind.ZodSet:
            return parseSetDef(def, refs);
        case ZodFirstPartyTypeKind.ZodLazy:
            return parseDef(def.getter()._def, refs);
        case ZodFirstPartyTypeKind.ZodPromise:
            return parsePromiseDef(def, refs);
        case ZodFirstPartyTypeKind.ZodNaN:
        case ZodFirstPartyTypeKind.ZodNever:
            return parseNeverDef();
        case ZodFirstPartyTypeKind.ZodEffects:
            return parseEffectsDef(def, refs, forceResolution);
        case ZodFirstPartyTypeKind.ZodAny:
            return parseAnyDef();
        case ZodFirstPartyTypeKind.ZodUnknown:
            return parseUnknownDef();
        case ZodFirstPartyTypeKind.ZodDefault:
            return parseDefaultDef(def, refs);
        case ZodFirstPartyTypeKind.ZodBranded:
            return parseBrandedDef(def, refs);
        case ZodFirstPartyTypeKind.ZodReadonly:
            return parseReadonlyDef(def, refs);
        case ZodFirstPartyTypeKind.ZodCatch:
            return parseCatchDef(def, refs);
        case ZodFirstPartyTypeKind.ZodPipeline:
            return parsePipelineDef(def, refs);
        case ZodFirstPartyTypeKind.ZodFunction:
        case ZodFirstPartyTypeKind.ZodVoid:
        case ZodFirstPartyTypeKind.ZodSymbol:
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
//# sourceMappingURL=parseDef.mjs.map