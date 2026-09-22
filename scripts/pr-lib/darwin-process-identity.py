"""Darwin PR-lock identity from libproc; no application dependency graph required.

Invoked with python3 -I -S -B to exclude ambient Python imports and bytecode writes.
No liveness decision is inferred from a failed query. The caller still owns v3
incarnation equality, process.kill(-pgid, 0), completion, drain and exact-OID CAS.
"""

import ctypes
import datetime
import sys


class BsdInfo(ctypes.Structure):
    # Darwin's public sys/proc_info.h PROC_PIDTBSDINFO ABI (arm64 and x86_64).
    _fields_ = (
        [(name, ctypes.c_uint32) for name in (
            "flags", "status", "xstatus", "pid", "ppid", "uid", "gid",
            "ruid", "rgid", "svuid", "svgid", "reserved",
        )]
        + [("comm", ctypes.c_char * 16), ("name", ctypes.c_char * 32)]
        + [(name, ctypes.c_uint32) for name in ("nfiles", "pgid", "pjobc", "tdev", "tpgid")]
        + [("nice", ctypes.c_int32), ("start_sec", ctypes.c_uint64), ("start_usec", ctypes.c_uint64)]
    )


STATES = {1: "I", 2: "R", 3: "S", 4: "T", 5: "Z"}
WEEKDAYS = ("Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun")
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def parse_pid(value):
    if not value or not value.isascii() or not value.isdecimal() or value.startswith("0"):
        raise ValueError("invalid PID")
    pid = int(value)
    if not 1 < pid <= 0x7FFFFFFF:
        raise ValueError("invalid PID")
    return pid


def birth_text(seconds):
    if not 0 < seconds <= 253402300799:
        raise ValueError("invalid process start time")
    started = datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc)
    # v3's ps -o lstart= is normalized by awk's field rebuilding. In particular
    # its blank-padded day becomes a single space plus an unpadded decimal day.
    # Fixed English names and UTC make this independent of the user's locale/TZ.
    return "{} {} {} {:02d}:{:02d}:{:02d} {:04d}".format(
        WEEKDAYS[started.weekday()], MONTHS[started.month - 1], started.day,
        started.hour, started.minute, started.second, started.year,
    )


def decode_info(pid, info, returned_bytes, error):
    # Absence, EPERM, short reads and ABI mismatches all remain unknown. None is
    # evidence that a stored owner's group is dead or that its ref may be erased.
    if returned_bytes != 136 or error != 0 or info.pid != pid:
        raise ValueError("kernel process identity unavailable")
    if info.status not in STATES or not 1 < info.pgid <= 0x7FFFFFFF:
        raise ValueError("invalid kernel process state or group")
    if info.start_usec >= 1_000_000:
        raise ValueError("invalid process start fraction")
    return STATES[info.status], birth_text(info.start_sec), info.pgid


def query_identity(pid):
    if type(pid) is not int or not 1 < pid <= 0x7FFFFFFF:
        raise ValueError("invalid PID")
    if sys.platform != "darwin" or ctypes.sizeof(BsdInfo) != 136:
        raise ValueError("unsupported process identity ABI")
    # Absolute public system library, not find_library or a caller-supplied FFI.
    lib = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    query = lib.proc_pidinfo
    query.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    query.restype = ctypes.c_int
    info = BsdInfo()
    ctypes.set_errno(0)
    returned_bytes = query(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
    return decode_info(pid, info, returned_bytes, ctypes.get_errno())


def main(args):
    try:
        if len(args) != 2 or args[0] not in ("identity", "pgid"):
            raise ValueError("expected identity|pgid PID")
        state, birth, pgid = query_identity(parse_pid(args[1]))
        print("{}\t{}".format(state, birth) if args[0] == "identity" else pgid)
        return 0
    except (ValueError, OSError, AttributeError, OverflowError) as error:
        print("Darwin process identity unavailable: {}".format(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
