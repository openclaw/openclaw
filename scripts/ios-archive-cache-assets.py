"""Diagnostic BOM comparison; only the observed two-record permutation is allowed.

Format basis: blacktop/ipsw a9eae76e (pkg/bom/bom.go),
hogliux/bomutils c247002 (src/bom.h). Every unrelated byte stays exact.
"""
import struct


def require(condition, message):
    if not condition:
        raise ValueError(message)


def u32(blob, offset):
    return struct.unpack_from(">I", blob, offset)[0]


def bom(data):
    magic, version, _, index, _, variables, var_len = struct.unpack_from(">8s6I", data)
    require(magic == b"BOMStore" and version == 1, "Unknown BOM format")
    blocks = [struct.unpack_from(">II", data, index + 4 + 8 * n)
              for n in range(u32(data, index))]
    roots = {}
    offset = variables + 4
    for _ in range(u32(data, variables)):
        block, length = struct.unpack_from(">IB", data, offset)
        offset += 5
        roots[data[offset:offset + length].decode()] = block
        offset += length
    require(offset == variables + var_len, "Unexpected BOM variable table")

    def block_bytes(block):
        offset, length = blocks[block]
        return data[offset:offset + length]

    appearance_root = block_bytes(roots["APPEARANCEKEYS"])
    require(appearance_root[:4] == b"tree", "Unknown appearance tree")
    leaf_id = u32(appearance_root, 8)
    leaf = block_bytes(leaf_id)
    is_leaf, count, forward, backward = struct.unpack_from(">HHII", leaf)
    require((is_leaf, count, forward, backward) == (1, 2, 0, 0),
            "Unexpected appearance entries")
    entries = []
    for n in range(count):
        value_id, key_id = struct.unpack_from(">II", leaf, 12 + n * 8)
        entries.append({"key_id": key_id, "value_id": value_id,
                        "key": block_bytes(key_id), "value": block_bytes(value_id)})
    return blocks, roots, index, leaf_id, entries


def compare(a, b):
    if a == b:
        return {"rawEqual": True, "wholeFileReconstructionEqual": True}
    ab, ar, ai, al, ae = bom(a)
    bb, br, bi, bl, be = bom(b)
    require(len(a) == len(b) and (ar, ai, al) == (br, bi, bl),
            "Catalog container changed")
    require({(e["key_id"], e["value_id"]) for e in ae} ==
            {(e["key_id"], e["value_id"]) for e in be}, "Appearance record slots changed")
    require(sorted((e["key"], e["value"]) for e in ae) ==
            sorted((e["key"], e["value"]) for e in be), "Appearance mapping changed")
    require({e["key"].decode(): int.from_bytes(e["value"], "little") for e in ae} ==
            {"UIAppearanceAny": 0, "UIAppearanceDark": 1}, "Unknown appearance mapping")
    reconstructed = bytearray(a)
    starts = sorted({offset for offset, length in ab if length})
    slot_sizes = {offset: next_start - offset for offset, next_start in zip(starts, starts[1:])}
    for target in be:
        source = next(e for e in ae if e["key"] == target["key"])
        require(source["value"] == target["value"], "Appearance value changed")
        for member in ("key_id", "value_id"):
            source_id, target_id = source[member], target[member]
            source_offset, source_length = ab[source_id]
            target_offset, target_length = bb[target_id]
            require(source_length == target_length and ab[target_id][0] == target_offset,
                    "Appearance allocation changed")
            require(slot_sizes[source_offset] == slot_sizes[target_offset] == 16,
                    "Unknown appearance record slot")
            reconstructed[target_offset:target_offset + 16] = a[source_offset:source_offset + 16]
            struct.pack_into(">I", reconstructed, ai + 4 + target_id * 8 + 4, source_length)
    leaf_offset, leaf_size = ab[al]
    require(bb[bl] == (leaf_offset, leaf_size) and
            a[leaf_offset:leaf_offset + 12] == b[leaf_offset:leaf_offset + 12],
            "Appearance leaf changed")
    for n, target in enumerate(be):
        struct.pack_into(">II", reconstructed, leaf_offset + 12 + n * 8,
                         target["value_id"], target["key_id"])
    require(bytes(reconstructed) == b, "Unexplained bytes outside appearance permutation")
    return {"rawEqual": False, "wholeFileReconstructionEqual": True,
            "changedByteCount": sum(x != y for x, y in zip(a, b)),
            "appearanceMapping": {"UIAppearanceAny": 0, "UIAppearanceDark": 1}}
