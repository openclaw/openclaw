//! Pre-build tool: reads meta JSON files and guanglun_reader data, generates src/data.json.gz.
//! Usage: cargo run --bin build-data --manifest-path cli/dacien-cli/Cargo.toml

use flate2::write::GzEncoder;
use flate2::Compression;
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::Path;

struct SeriesDef {
    id: &'static str,
    dir: &'static str,
    name: &'static str,
    group_id: &'static str,
}

const DOWNLOAD_DIR: &str = r"D:\work\go\gl-downloader\download";
const READER_DIR: &str = r"D:\work\go\guanglun_reader\data";

const SERIES: &[SeriesDef] = &[
    SeriesDef { id: "guanghai",  dir: "广海明月",                          name: "广海明月",                          group_id: "B000035" },
    SeriesDef { id: "guanglun",  dir: "菩提道次第廣論手抄稿（南普陀版）",  name: "菩提道次第广论手抄稿（南普陀版）",  group_id: "B000027" },
    SeriesDef { id: "nanshan",   dir: "南山律在家备览略编手抄稿（1991年版）", name: "南山律在家备览略编手抄稿（1991年版）", group_id: "B000016" },
    SeriesDef { id: "zhiguan",   dir: "廣論止觀初探-音档",                name: "广论止观初探",                      group_id: "B000036" },
    SeriesDef { id: "daocidi",   dir: "道次第略義淺釋-音档",              name: "道次第略义浅释",                    group_id: "B000197" },
    SeriesDef { id: "biboshena", dir: "廣論止觀初探・毗缽舍那-音档",      name: "广论止观初探·毗钵舍那",            group_id: "B000211" },
];

fn strip_html(html: &str) -> String {
    let mut result = String::with_capacity(html.len());
    let mut in_tag = false;
    for ch in html.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => {
                in_tag = false;
                result.push(' ');
            }
            _ if !in_tag => result.push(ch),
            _ => {}
        }
    }
    let mut out = String::with_capacity(result.len());
    let mut prev_ws = false;
    for ch in result.chars() {
        if ch.is_whitespace() {
            if !prev_ws {
                out.push(' ');
            }
            prev_ws = true;
        } else {
            out.push(ch);
            prev_ws = false;
        }
    }
    out.trim().to_string()
}

/// Flatten the kejuan tree into a list of nodes with depth, path, and paragraph_range.
fn flatten_kejuan(node: &Value, depth: u32, path: &[String]) -> Vec<Value> {
    let mut results = Vec::new();
    let title = node["title"].as_str().unwrap_or("").to_string();
    if title.is_empty() {
        return results;
    }

    let mut current_path = path.to_vec();
    current_path.push(title.clone());

    let para_range = if let Some(pr) = node.get("paragraph_range") {
        json!({
            "start": pr["start_id"].as_u64().unwrap_or(0),
            "end": pr["end_id"].as_u64().unwrap_or(0)
        })
    } else {
        json!(null)
    };

    let has_children = node.get("children")
        .and_then(|c| c.get("attached"))
        .and_then(|a| a.as_array())
        .map(|a| !a.is_empty())
        .unwrap_or(false);

    results.push(json!({
        "title": title,
        "depth": depth,
        "path": current_path,
        "paragraph_range": para_range,
        "has_children": has_children,
    }));

    if let Some(children) = node.get("children")
        .and_then(|c| c.get("attached"))
        .and_then(|a| a.as_array())
    {
        for child in children {
            results.extend(flatten_kejuan(child, depth + 1, &current_path));
        }
    }

    results
}

/// Build kejuan data from 科判_带段落区间.json
fn build_kejuan() -> Value {
    let kejuan_path = Path::new(READER_DIR).join("广论").join("科判_带段落区间.json");
    if !kejuan_path.exists() {
        eprintln!("WARN: kejuan file not found: {}", kejuan_path.display());
        return json!({ "nodes": [], "paragraphs": [] });
    }

    let content = fs::read_to_string(&kejuan_path).expect("failed to read kejuan");
    let raw: Value = serde_json::from_str(&content).expect("failed to parse kejuan");

    let root = &raw["content"][0]["rootTopic"];
    let nodes = flatten_kejuan(root, 0, &[]);
    eprintln!("Kejuan: {} nodes", nodes.len());

    // Load guanglun original text paragraphs
    let para_path = Path::new(READER_DIR).join("广论").join("菩提道次第广论原文_状态机分类段落.json");
    let paragraphs = if para_path.exists() {
        let content = fs::read_to_string(&para_path).expect("failed to read paragraphs");
        let raw: Value = serde_json::from_str(&content).expect("failed to parse paragraphs");
        let paras: Vec<Value> = raw.as_array().unwrap_or(&vec![]).iter().map(|p| {
            json!({
                "id": p["id"].as_u64().unwrap_or(0),
                "text": p["text"].as_str().unwrap_or(""),
                "type": p["text_type"].as_str().unwrap_or(""),
                "page": p["page_number_display"].as_str().unwrap_or(""),
                "kejuan_title": p["kejuan_title"].as_str().unwrap_or(""),
            })
        }).collect();
        eprintln!("Guanglun original paragraphs: {}", paras.len());
        json!(paras)
    } else {
        eprintln!("WARN: paragraphs file not found");
        json!([])
    };

    json!({
        "nodes": nodes,
        "paragraphs": paragraphs
    })
}

/// Build cross-reference data: guanghai ↔ shifu (hand-transcripts)
fn build_xref() -> Value {
    let matched_path = Path::new(READER_DIR)
        .join("广海明月")
        .join("processed_data")
        .join("shifu_matches")
        .join("laoshi_shifu_matched.json");

    if !matched_path.exists() {
        eprintln!("WARN: xref file not found: {}", matched_path.display());
        return json!({ "guanghai_to_shifu": [] });
    }

    let content = fs::read_to_string(&matched_path).expect("failed to read xref");
    let raw: Value = serde_json::from_str(&content).expect("failed to parse xref");

    let mut refs = Vec::new();
    if let Some(matched) = raw["matched_quotes"].as_array() {
        for m in matched {
            let laoshi = &m["laoshi_quote"];
            let laoshi_vol = m["laoshi_volume_number"].as_u64().unwrap_or(0);
            let shifu_vol = m["shifu_volume_number"].as_u64().unwrap_or(0);
            let shifu_volume_name = m["shifu_volume"].as_str().unwrap_or("");
            let shifu_kejuan = m["shifu_kejuan"].as_str().unwrap_or("");
            let score = m["match_score"].as_f64().unwrap_or(0.0);
            let quote_text = m["quote_text"].as_str().unwrap_or("");
            let matched_text = m["matched_text"].as_str().unwrap_or("");

            // Only include good matches
            if score < 0.5 || shifu_vol == 0 {
                continue;
            }

            // Extract laoshi audio_info timestamp if available
            let audio_time = laoshi.get("audio_info")
                .and_then(|a| a["time_seconds"].as_u64());

            refs.push(json!({
                "guanghai_vol": laoshi_vol,
                "quote": quote_text,
                "shifu_vol": shifu_vol,
                "shifu_tape": shifu_volume_name,
                "shifu_kejuan": shifu_kejuan,
                "matched_text": matched_text,
                "score": (score * 100.0).round() / 100.0,
                "audio_time": audio_time,
            }));
        }
    }

    eprintln!("Cross-references: {} matched pairs (score >= 0.5)", refs.len());

    json!({
        "guanghai_to_shifu": refs
    })
}

fn main() {
    let download_dir = Path::new(DOWNLOAD_DIR);
    let mut all_series: Vec<Value> = Vec::new();

    for s in SERIES {
        let meta_dir = download_dir.join(s.dir).join("meta");
        if !meta_dir.exists() {
            eprintln!("WARN: skipping {}, meta dir not found: {}", s.dir, meta_dir.display());
            continue;
        }

        let mut entries: Vec<u32> = fs::read_dir(&meta_dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name();
                let name = name.to_str()?;
                if name.ends_with(".json") {
                    name.trim_end_matches(".json").parse::<u32>().ok()
                } else {
                    None
                }
            })
            .collect();
        entries.sort();

        let want_audio = true;
        let mut volumes: Vec<Value> = Vec::new();

        for num in &entries {
            let fpath = meta_dir.join(format!("{}.json", num));
            let content = match fs::read_to_string(&fpath) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("WARN: failed to read {}: {}", fpath.display(), e);
                    continue;
                }
            };

            let raw: Value = match serde_json::from_str(&content) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("WARN: failed to parse {}: {}", fpath.display(), e);
                    continue;
                }
            };

            let title = raw["title"].as_str().unwrap_or("").to_string();
            let volume = raw["volume"].as_u64().unwrap_or(0);
            let body_html = raw["body"].as_str().unwrap_or("");
            let body_text = strip_html(body_html);

            let front: Vec<Value> = raw["front"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .map(|f| {
                            json!({
                                "title": f["title"].as_str().unwrap_or(""),
                                "value": f["value"].as_str().unwrap_or("")
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();

            let media_arr = raw["media"].as_array();
            let media_items: Vec<Value> = media_arr
                .map(|arr| {
                    arr.iter()
                        .filter(|m| m["mediaType"].as_str().unwrap_or("") == "audio/mpeg")
                        .map(|m| {
                            json!({
                                "type": m["mediaType"].as_str().unwrap_or(""),
                                "src": m["src"].as_str().unwrap_or(""),
                                "duration": m["duration"].as_u64().unwrap_or(0)
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();

            if want_audio && !media_items.iter().any(|m| m["type"] == "audio/mpeg") {
                continue;
            }

            volumes.push(json!({
                "volume": volume,
                "title": title,
                "front": front,
                "media": media_items,
                "body": body_text
            }));
        }

        eprintln!("Series '{}' ({}): {} volumes", s.name, s.id, volumes.len());

        all_series.push(json!({
            "id": s.id,
            "name": s.name,
            "group_id": s.group_id,
            "count": volumes.len(),
            "volumes": volumes
        }));
    }

    // Build enhanced data
    let kejuan = build_kejuan();
    let xref = build_xref();

    let output = json!({
        "series": all_series,
        "kejuan": kejuan,
        "xref": xref
    });

    let json_bytes = serde_json::to_vec(&output).unwrap();
    let json_mb = json_bytes.len() as f64 / 1024.0 / 1024.0;

    let out_path = Path::new(env!("CARGO_MANIFEST_DIR")).join("src").join("data.json.gz");
    let file = fs::File::create(&out_path).unwrap();
    let mut encoder = GzEncoder::new(file, Compression::best());
    encoder.write_all(&json_bytes).unwrap();
    encoder.finish().unwrap();

    let gz_size = fs::metadata(&out_path).unwrap().len();
    let gz_mb = gz_size as f64 / 1024.0 / 1024.0;
    eprintln!("Written {} (JSON {:.1} MB → gzip {:.1} MB, {:.0}% reduction)",
        out_path.display(), json_mb, gz_mb, (1.0 - gz_mb / json_mb) * 100.0);
}
