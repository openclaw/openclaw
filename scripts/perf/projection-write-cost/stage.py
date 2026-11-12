import json
import pathlib
import resource
import subprocess
import sys
import time

output = pathlib.Path(sys.argv[1])
command = sys.argv[2:]


def io():
    return {
        key: int(value)
        for key, value in (
            line.split(":") for line in pathlib.Path("/proc/self/io").read_text().splitlines()
        )
    }


before = io()
started = time.monotonic()
result = subprocess.run(command)
elapsed = time.monotonic() - started
usage = resource.getrusage(resource.RUSAGE_CHILDREN)
after = io()
row = {
    "command": command,
    "exit": result.returncode,
    "wallMs": elapsed * 1000,
    "cpuMs": (usage.ru_utime + usage.ru_stime) * 1000,
    "maxRssKiB": usage.ru_maxrss,
    "blockOutputBytes": usage.ru_oublock * 512,
    "writeBytes": after["write_bytes"] - before["write_bytes"],
    "cancelledWriteBytes": after["cancelled_write_bytes"] - before["cancelled_write_bytes"],
    "readBytes": after["read_bytes"] - before["read_bytes"],
    "load": pathlib.Path("/proc/loadavg").read_text().strip(),
}
output.write_text(json.dumps(row))
sys.exit(result.returncode)
