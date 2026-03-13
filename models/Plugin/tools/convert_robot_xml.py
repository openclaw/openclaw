import argparse, json, sys, xml.etree.ElementTree as ET
from pathlib import Path

def _text(elem, tag, default=0.0):
    if elem is None: return default
    c = elem.find(tag)
    if c is None or c.text is None: return default
    return float(c.text.strip())

def _find_xml(directory, subdir):
    sub = Path(directory) / subdir
    if not sub.is_dir(): return None
    xmls = list(sub.glob("*.xml"))
    return xmls[0] if xmls else None

def parse_rlkin(path):
    root = ET.parse(path).getroot()
    puma = root.find(".//puma")
    if puma is None: raise ValueError("No puma element in " + str(path))
    manufacturer = (puma.findtext("manufacturer") or "").strip()
    name = (puma.findtext("name") or "").strip()
    joints = []
    for idx, el in enumerate(puma.findall("revolute")):
        dh_el = el.find("dh")
        joints.append({
            "id":    el.get("id", "joint" + str(idx)),
            "index": idx,
            "min":   float(el.findtext("min") or "0"),
            "max":   float(el.findtext("max") or "0"),
            "speed": float(el.findtext("speed") or "0"),
            "dh":    {"d": _text(dh_el,"d"), "theta": _text(dh_el,"theta"),
                      "a": _text(dh_el,"a"), "alpha": _text(dh_el,"alpha")},
        })
    if not joints: raise ValueError("No revolute joints in " + str(path))
    return {"manufacturer": manufacturer, "name": name, "joints": joints}

def parse_rlmdl(path):
    root = ET.parse(path).getroot()
    model = root.find(".//model")
    if model is None: raise ValueError("No model element in " + str(path))
    world = model.find("world")
    g = world.find("g") if world is not None else None
    gravity = [_text(g,"x"), _text(g,"y"), _text(g,"z")]
    children = list(model)
    joints = []
    ji = 0
    for i, child in enumerate(children):
        if child.tag != "revolute": continue
        t, r = [0.0,0.0,0.0], [0.0,0.0,0.0]
        if i+1 < len(children) and children[i+1].tag == "fixed":
            fix = children[i+1]
            tr = fix.find("translation"); ro = fix.find("rotation")
            if tr is not None: t = [_text(tr,"x"),_text(tr,"y"),_text(tr,"z")]
            if ro is not None: r = [_text(ro,"x"),_text(ro,"y"),_text(ro,"z")]
        joints.append({"id": child.get("id","joint"+str(ji)),
                        "min": float(child.findtext("min") or "0"),
                        "max": float(child.findtext("max") or "0"),
                        "speed": float(child.findtext("speed") or "0"),
                        "link_translation": t, "link_rotation": r})
        ji += 1
    return {"gravity": gravity, "joints": joints}

DEF_AXES   = [[0,0,1],[0,1,0],[0,1,0],[1,0,0],[0,1,0],[1,0,0]]
DEF_LABELS = ["J1 - Base Rotation","J2 - Shoulder","J3 - Elbow",
               "J4 - Forearm Roll","J5 - Wrist Pitch","J6 - Flange Roll"]

def clamp(v,mn,mx): return max(mn,min(mx,v))

def make_presets(joints):
    dof = len(joints)
    def fit(vals):
        p = (list(vals) + [0.0]*dof)[:dof]
        return [clamp(p[i], joints[i]["min"], joints[i]["max"]) for i in range(dof)]
    return {
        "home":        fit([0,0,0,0,0,0]),
        "ready":       fit([0,-30,60,0,30,0]),
        "inspect":     fit([0,-45,90,0,-45,0]),
        "pick_low":    fit([0,30,90,0,-30,0]),
        "stretch_up":  fit([0,-90,0,0,0,0]),
        "stretch_fwd": fit([0,0,-90,0,90,0]),
        "tuck":        fit([0,90,-90,0,0,0]),
        "wave":        fit([45,-30,60,0,30,0]),
        "salute":      fit([0,-60,0,0,60,0]),
        "dance_a":     fit([90,-30,60,45,30,0]),
        "dance_b":     fit([-90,-30,60,-45,30,0]),
    }

def make_sequences(joints, presets):
    dof = len(joints)
    def fit(vals):
        p = (list(vals)+[0.0]*dof)[:dof]
        return [clamp(p[i],joints[i]["min"],joints[i]["max"]) for i in range(dof)]
    def step(j,ms): return {"joints":[float(v) for v in j],"durationMs":ms}
    home  = presets.get("home",  fit([0]*dof))
    wave  = presets.get("wave",  home)
    da    = presets.get("dance_a", home)
    db    = presets.get("dance_b", home)
    j4max = joints[4]["max"] if dof>4 else 180
    j4min = joints[4]["min"] if dof>4 else -180
    whi = list(wave); whi[4] = min(j4max, wave[4]+30)
    wlo = list(wave); wlo[4] = max(j4min, wave[4]-20)
    return {
        "wave_sequence":    {"description":"Friendly wave motion",
            "steps":[step(wave,800),step(whi,400),step(wlo,400),step(whi,400),step(wlo,400),step(home,800)]},
        "dance_sequence":   {"description":"Playful dance motion",
            "steps":[step(da,600),step(db,600),step(da,600),step(db,600),step(home,800)]},
        "nod_sequence":     {"description":"Nodding yes motion",
            "steps":[step(fit([0,-20,40,0,40,0]),600),step(fit([0,-20,40,0,60,0]),300),
                     step(fit([0,-20,40,0,40,0]),300),step(fit([0,-20,40,0,60,0]),300),step(home,600)]},
        "inspect_sequence": {"description":"Inspection scan motion",
            "steps":[step(fit([-45,-45,90,0,-45,0]),700),step(fit([-45,-45,90,0,0,0]),500),
                     step(fit([45,-45,90,0,0,0]),1000),step(fit([45,-45,90,0,-45,0]),500),step(home,800)]},
    }

def build_json(rlkin, rlmdl, robot_id, glb_file=None, include_presets=True):
    kj, mj = rlkin["joints"], rlmdl["joints"]
    dof = len(kj)
    # Cross-validate
    for i in range(min(len(kj),len(mj))):
        k, m = kj[i], mj[i]
        if abs(k["min"]-m["min"])>0.001 or abs(k["max"]-m["max"])>0.001:
            print("  WARN joint{}: rlkin [{},{}] != rlmdl [{},{}] - using rlkin".format(
                  i, k["min"],k["max"],m["min"],m["max"]), file=sys.stderr)
    axes   = (DEF_AXES   + [[0,0,1]]*dof)[:dof]
    labels = (DEF_LABELS + ["J"+str(i+1) for i in range(dof)])[:dof]
    joints_out = []
    for i, j in enumerate(kj):
        joints_out.append({"index":i,"id":j["id"],"label":labels[i],"type":"revolute",
                            "min":j["min"],"max":j["max"],"speed":j["speed"],
                            "home":0.0,"axis":axes[i],"unit":"deg"})
    dh_out = [{"jointId":j["id"],"d":j["dh"]["d"],"theta":j["dh"]["theta"],
               "a":j["dh"]["a"],"alpha":j["dh"]["alpha"]} for j in kj]
    link_offsets = [{"jointId":j["id"],"translation":j.get("link_translation",[0,0,0]),
                     "rotation":j.get("link_rotation",[0,0,0])} for j in mj]
    cfg = {
        "$schema":"../robot-config.schema.json","id":robot_id,"version":"1.0.0",
        "manufacturer":rlkin["manufacturer"],"model":rlkin["name"],
        "description":"{} {} - {}-DOF serial robot arm".format(rlkin["manufacturer"],rlkin["name"],dof),
        "dof":dof,"mechanismType":"serial_6dof" if dof==6 else "serial",
        "joints":joints_out,"dhParameters":dh_out,"linkOffsets":link_offsets,
        "gravity":rlmdl["gravity"],
    }
    if glb_file: cfg["glbFile"] = glb_file
    if include_presets:
        p = make_presets(joints_out)
        cfg["presets"]   = p
        cfg["sequences"] = make_sequences(joints_out, p)
    return cfg

def verify_json(out_path, rlkin):
    print("\n--- Verification: {} ---".format(out_path))
    with open(out_path, encoding="utf-8") as f:
        data = json.load(f)
    kj = rlkin["joints"]
    ok = True
    for i, (src, dst) in enumerate(zip(kj, data["joints"])):
        errs = []
        if abs(src["min"]-dst["min"])>0.001:   errs.append("min {} vs {}".format(src["min"],dst["min"]))
        if abs(src["max"]-dst["max"])>0.001:   errs.append("max {} vs {}".format(src["max"],dst["max"]))
        if abs(src["speed"]-dst["speed"])>0.001: errs.append("speed {} vs {}".format(src["speed"],dst["speed"]))
        if errs: print("  FAIL joint{} ({}): {}".format(i,src["id"],", ".join(errs))); ok=False
        else:    print("  OK   joint{} ({}): min={} max={} speed={}".format(i,src["id"],dst["min"],dst["max"],dst["speed"]))
    for i, (src, dst) in enumerate(zip(kj, data["dhParameters"])):
        dh = src["dh"]; errs = []
        for k in ["d","theta","a","alpha"]:
            if abs(dh[k]-dst[k])>0.00001: errs.append("{}: {} vs {}".format(k,dh[k],dst[k]))
        if errs: print("  FAIL DH  joint{}: {}".format(i,", ".join(errs))); ok=False
        else:    print("  OK   DH  joint{}: d={} theta={} a={} alpha={}".format(i,dst["d"],dst["theta"],dst["a"],dst["alpha"]))
    for pname, pvals in data.get("presets",{}).items():
        for i, v in enumerate(pvals):
            j = data["joints"][i]
            if v < j["min"] or v > j["max"]:
                print("  FAIL preset {} joint{}: {} out of [{},{}]".format(pname,i,v,j["min"],j["max"])); ok=False
    if ok: print("  ALL CHECKS PASSED")
    else:  print("  SOME CHECKS FAILED"); sys.exit(1)
    return ok

def main():
    ap = argparse.ArgumentParser(description="Convert rlkin+rlmdl XML to OpenClaw plugin JSON")
    ap.add_argument("--rlkin",     help="rlkin XML path")
    ap.add_argument("--rlmdl",     help="rlmdl XML path")
    ap.add_argument("--robot-dir", help="Robot dir containing rlkin/ and rlmdl/ subdirs")
    ap.add_argument("--out",       required=True, help="Output JSON path")
    ap.add_argument("--robot-id",  help="Robot ID (default: output stem)")
    ap.add_argument("--glb",       help="Relative GLB model path")
    ap.add_argument("--presets",   action="store_true", default=True)
    ap.add_argument("--no-presets",dest="presets",action="store_false")
    ap.add_argument("--verify",    action="store_true")
    args = ap.parse_args()
    if args.robot_dir:
        rd = Path(args.robot_dir)
        rlkin_p = _find_xml(rd,"rlkin")
        rlmdl_p = _find_xml(rd,"rlmdl")
        if not rlkin_p: raise FileNotFoundError("No rlkin XML in "+str(rd/"rlkin"))
        if not rlmdl_p: raise FileNotFoundError("No rlmdl XML in "+str(rd/"rlmdl"))
    else:
        if not args.rlkin or not args.rlmdl: ap.error("Provide --robot-dir OR both --rlkin and --rlmdl")
        rlkin_p, rlmdl_p = Path(args.rlkin), Path(args.rlmdl)
    out_p    = Path(args.out)
    robot_id = args.robot_id or out_p.stem
    print("Converting: {} + {} -> {}".format(rlkin_p.name, rlmdl_p.name, out_p))
    rlkin_d = parse_rlkin(rlkin_p)
    rlmdl_d = parse_rlmdl(rlmdl_p)
    print("  Robot: {} {} ({} joints)".format(rlkin_d["manufacturer"],rlkin_d["name"],len(rlkin_d["joints"])))
    for j in rlkin_d["joints"]:
        print("    {}: [{}, {}] speed={} dh={}".format(j["id"],j["min"],j["max"],j["speed"],j["dh"]))
    cfg = build_json(rlkin_d, rlmdl_d, robot_id, args.glb, args.presets)
    out_p.parent.mkdir(parents=True, exist_ok=True)
    with open(out_p,"w",encoding="utf-8") as f:
        json.dump(cfg, f, indent=2, ensure_ascii=False)
    print("  Written: {} ({} bytes)".format(out_p, out_p.stat().st_size))
    if args.verify:
        verify_json(out_p, rlkin_d)

if __name__ == "__main__":
    main()
