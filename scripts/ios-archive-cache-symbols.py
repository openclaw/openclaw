"""Offline diagnostic decoder using the selected Xcode's private Apple APIs.

The session and Blocks layouts were checked against Apple libatos disassembly.
This is qualification tooling, not a production dependency or format guarantee.
"""
import argparse
import ctypes as ct
import hashlib
import json
import sys
import time
import uuid
from pathlib import Path

ALIASES = {
    "/Applications/Xcode_27.1.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS.sdk/":
        "/Applications/Xcode_27.1.app/Contents/Developer/Platforms/iPhoneOS.platform/Developer/SDKs/iPhoneOS27.1.sdk/",
    "/Applications/Xcode_27.1.app/Contents/Developer/Platforms/WatchOS.platform/Developer/SDKs/WatchOS.sdk/":
        "/Applications/Xcode_27.1.app/Contents/Developer/Platforms/WatchOS.platform/Developer/SDKs/WatchOS27.0.sdk/",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=True)


def digest(rows):
    return hashlib.sha256(canonical(rows).encode()).hexdigest()


def normalize(path):
    for old, new in ALIASES.items():
        if path and path.startswith(old):
            return new + path[len(old):]
    return path


def decode(file, resources):
    sys.path.insert(0, str(resources))
    import libatos
    from libatos import libatos as native

    class Ref(ct.Structure):
        _fields_ = [("data", ct.c_void_p), ("obj", ct.c_void_p)]

    class Range(ct.Structure):
        _fields_ = [("location", ct.c_uint64), ("length", ct.c_uint64)]

    cs = ct.CDLL("/System/Library/PrivateFrameworks/CoreSymbolication.framework/CoreSymbolication")

    def api(name, args, result):
        fn = getattr(cs, name)
        fn.argtypes, fn.restype = args, result
        return fn

    owner_for = api("CSSymbolicatorGetSymbolOwner", [Ref], Ref)
    uuid_for = api("CSSymbolOwnerGetCFUUIDBytes", [Ref], ct.c_void_p)
    symbol_count = api("CSSymbolOwnerGetSymbolCount", [Ref], ct.c_size_t)
    source_count = api("CSSymbolOwnerGetSourceInfoCount", [Ref], ct.c_size_t)
    symbol_name = api("CSSymbolGetName", [Ref], ct.c_char_p)
    symbol_mangled = api("CSSymbolGetMangledName", [Ref], ct.c_char_p)
    symbol_flags = api("CSSymbolGetFlags", [Ref], ct.c_uint32)
    symbol_range = api("CSSymbolGetRange", [Ref], Range)
    is_deduplicated = api("CSSymbolIsDeduplicated", [Ref], ct.c_bool)
    source_path = api("CSSourceInfoGetPath", [Ref], ct.c_char_p)
    source_line = api("CSSourceInfoGetLineNumber", [Ref], ct.c_uint32)
    source_column = api("CSSourceInfoGetColumn", [Ref], ct.c_uint32)
    source_discriminator = api("CSSourceInfoGetDiscriminator", [Ref], ct.c_uint32)
    source_range = api("CSSourceInfoGetRange", [Ref], Range)

    class Descriptor(ct.Structure):
        _fields_ = [("reserved", ct.c_ulong), ("size", ct.c_ulong)]

    Invoke = ct.CFUNCTYPE(None, ct.c_void_p, Ref)

    class Block(ct.Structure):
        _fields_ = [("isa", ct.c_void_p), ("flags", ct.c_int), ("reserved", ct.c_int),
                    ("invoke", Invoke), ("descriptor", ct.POINTER(Descriptor))]

    isa = ct.addressof((ct.c_void_p * 32).in_dll(ct.CDLL(None), "_NSConcreteGlobalBlock"))

    def collect(name, owner, fn):
        rows, errors = [], []

        def visit(_, ref):
            try:
                rows.append(fn(ref))
            except Exception as error:
                errors.append(str(error))

        invoke = Invoke(visit)
        descriptor = Descriptor(0, ct.sizeof(Block))
        block = Block(isa, 1 << 28, 0, invoke, ct.pointer(descriptor))
        api(name, [Ref, ct.POINTER(Block)], None)(owner, ct.byref(block))
        require(not errors, f"Native enumeration failed: {errors}")
        return rows

    def text(value):
        return value.decode("utf8") if value is not None else None

    def address_range(value):
        return [value.location, value.length]

    started = time.monotonic()
    session = libatos.CreateSessionWithSignaturePath(str(file))
    require(session, "No signature session")
    try:
        owner = owner_for(Ref.from_address(session))
        uuid_bytes = uuid_for(owner)
        require(uuid_bytes, "Missing owner UUID")
        native_uuid = uuid.UUID(bytes=ct.string_at(uuid_bytes, 16))
        require(native_uuid == libatos.Segments(session).uuid == uuid.UUID(file.stem),
                "Signature UUID mismatch")
        ns, nl = symbol_count(owner), source_count(owner)
        require(0 < ns < 20000000 and 0 < nl < 20000000, "Invalid native owner counts")
        deduplicated = []

        def symbol_row(ref):
            return [text(symbol_mangled(ref)), text(symbol_name(ref)), symbol_flags(ref),
                    address_range(symbol_range(ref))]

        def symbol_with_variants(ref):
            row = symbol_row(ref)
            if is_deduplicated(ref):
                variants = collect("CSSymbolForeachDeduplicatedSymbolVariant", ref, symbol_row)
                require(variants, "Missing deduplicated variants")
                deduplicated.append([row, sorted(variants, key=canonical)])
            return row

        symbols = collect("CSSymbolOwnerForeachSymbol", owner, symbol_with_variants)
        sources = collect("CSSymbolOwnerForeachSourceInfo", owner, lambda ref: [
            text(source_path(ref)), source_line(ref), source_column(ref),
            source_discriminator(ref), address_range(source_range(ref))])
        require(len(symbols) == ns and len(sources) == nl, "Incomplete native enumeration")
        normalized, normalized_paths = [], {}
        for row in sources:
            normalized_path = normalize(row[0])
            if normalized_path != row[0]:
                normalized_paths[row[0]] = normalized_paths.get(row[0], 0) + 1
            normalized.append([normalized_path, *row[1:]])
        result = {
            "uuid": str(native_uuid), "symbolCount": ns, "sourceInfoCount": nl,
            "deduplicatedSymbolCount": len(deduplicated),
            "deduplicatedVariantCount": sum(len(row[1]) for row in deduplicated),
            "symbolTableSha256": digest(sorted(symbols, key=canonical)),
            "deduplicatedVariantsSha256": digest(sorted(deduplicated, key=canonical)),
            "sourceTableSha256": digest(sorted(sources, key=canonical)),
            "sourceTableSdkAliasNormalizedSha256": digest(sorted(normalized, key=canonical)),
            "normalizedPathCounts": normalized_paths,
        }
        addresses = set()
        for row in symbols + sources:
            location, length = row[-1]
            addresses.add(location)
            if length:
                addresses.add(location + length - 1)
        addresses = sorted(addresses)
        inline_digest = hashlib.sha256()
        nonempty, inline_queries, max_depth = 0, 0, 0
        for start in range(0, len(addresses), 1024):
            batch = addresses[start:start + 1024]
            queries = (ct.c_ulonglong * len(batch))(*batch)
            answer = native._SymbolicateAddresses(session, queries, len(batch))
            require(answer, "No native boundary result")
            try:
                require(answer.contents.symbol_count == len(batch), "Incomplete boundary results")
                for index, address in enumerate(batch):
                    symbol, chain = answer.contents.symbols[index], []
                    while symbol:
                        require(len(chain) < 256, "Unexpected inline chain depth")
                        current, source = symbol.contents, None
                        if current.source_info:
                            src = current.source_info.contents
                            # Read native range before destroying the result; Apple's Python
                            # SourceInfo wrapper incorrectly assigns the builtin `range`.
                            source = [normalize(text(src.path)), src.line_number, src.column,
                                      address_range(src.range)]
                        chain.append([text(current.mangled_name), text(current.name), current.flags,
                                      address_range(current.range), source])
                        symbol = current.inlined_symbol
                    nonempty += bool(chain)
                    inline_queries += len(chain) > 1
                    max_depth = max(max_depth, len(chain))
                    inline_digest.update(canonical([address, chain]).encode() + b"\n")
            finally:
                native._DestroySymbolicationResult(answer)
        require(addresses and nonempty == len(addresses), "Empty boundary symbolication")
        result.update({"boundaryAddressCount": len(addresses),
                       "boundaryAddressesSha256": digest(addresses),
                       "nonemptyQueries": nonempty, "queriesWithInlineChains": inline_queries,
                       "maxChainDepth": max_depth,
                       "boundaryInlineResultsSdkAliasNormalizedSha256": inline_digest.hexdigest(),
                       "wallSeconds": time.monotonic() - started})
        return result
    finally:
        libatos.DestroySymbolicationSession(session)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("file", type=Path)
    parser.add_argument("--resources", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(decode(args.file, args.resources), separators=(",", ":")))
