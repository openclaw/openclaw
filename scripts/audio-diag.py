import sounddevice
import sys

print("=== SOUND DEVICE LIST ===")
devices = sounddevice.query_devices()
print(devices)

default_out = sounddevice.default.device[1]
print(f"\nDefault Output Device Index: {default_out}")
print(f"Default Output Device Name: {devices[default_out]['name']}")

cable_found = False
for i, d in enumerate(devices):
    if "CABLE Input" in d["name"]:
        print(f"CABLE Input Found at Index: {i}")
        cable_found = True
        break

if not cable_found:
    print("WARNING: CABLE Input NOT found.")
