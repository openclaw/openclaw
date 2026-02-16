use flate2::read::GzDecoder;
use serde::{Deserialize, Serialize};
use std::env;
use std::io::Read;

static DATA_GZ: &[u8] = include_bytes!("data.json.gz");

#[derive(Deserialize)]
struct Database {
    series: Vec<Series>,
    #[serde(default)]
    kejuan: Option<KejuanData>,
    #[serde(default)]
    xref: Option<XrefData>,
}

#[derive(Deserialize)]
struct Series {
    id: String,
    name: String,
    #[allow(dead_code)]
    group_id: String,
    count: usize,
    volumes: Vec<Volume>,
}

#[derive(Deserialize)]
struct Volume {
    volume: u64,
    title: String,
    front: Vec<FrontMatter>,
    media: Vec<MediaItem>,
    body: String,
}

#[derive(Deserialize, Serialize)]
struct FrontMatter {
    title: String,
    value: String,
}

#[derive(Deserialize, Serialize)]
struct MediaItem {
    #[serde(rename = "type")]
    media_type: String,
    src: String,
    duration: u64,
}

// --- Kejuan types ---

#[derive(Deserialize)]
struct KejuanData {
    nodes: Vec<KejuanNode>,
    paragraphs: Vec<KejuanParagraph>,
}

#[derive(Deserialize, Serialize, Clone)]
struct KejuanNode {
    title: String,
    depth: u32,
    path: Vec<String>,
    paragraph_range: Option<ParaRange>,
    has_children: bool,
}

#[derive(Deserialize, Serialize, Clone)]
struct ParaRange {
    start: u64,
    end: u64,
}

#[derive(Deserialize, Serialize)]
struct KejuanParagraph {
    id: u64,
    text: String,
    #[serde(rename = "type")]
    text_type: String,
    page: String,
    kejuan_title: String,
}

// --- Xref types ---

#[derive(Deserialize)]
struct XrefData {
    guanghai_to_shifu: Vec<XrefMatch>,
}

#[derive(Deserialize, Serialize)]
struct XrefMatch {
    guanghai_vol: u64,
    quote: String,
    shifu_vol: u64,
    shifu_tape: String,
    shifu_kejuan: String,
    matched_text: String,
    score: f64,
    audio_time: Option<u64>,
}

// --- Output types ---

#[derive(Serialize)]
struct ListOutput {
    total_series: usize,
    total_volumes: usize,
    series: Vec<SeriesSummary>,
}

#[derive(Serialize)]
struct SeriesSummary {
    id: String,
    name: String,
    count: usize,
}

#[derive(Serialize)]
struct SearchOutput {
    query: String,
    total: usize,
    results: Vec<SearchResult>,
}

#[derive(Serialize)]
struct SearchResult {
    series_id: String,
    series_name: String,
    volume: u64,
    title: String,
    snippet: String,
}

#[derive(Serialize)]
struct ShowOutput {
    series_id: String,
    series_name: String,
    volume: u64,
    title: String,
    front: Vec<FrontMatter>,
    media: Vec<MediaItem>,
    body: String,
}

fn load_db() -> Database {
    let mut decoder = GzDecoder::new(DATA_GZ);
    let mut json_str = String::new();
    decoder.read_to_string(&mut json_str).expect("failed to decompress data");
    serde_json::from_str(&json_str).expect("failed to parse data")
}

fn cmd_list(db: &Database) {
    let total_volumes: usize = db.series.iter().map(|s| s.count).sum();
    let output = ListOutput {
        total_series: db.series.len(),
        total_volumes,
        series: db
            .series
            .iter()
            .map(|s| SeriesSummary {
                id: s.id.clone(),
                name: s.name.clone(),
                count: s.count,
            })
            .collect(),
    };
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}

fn cmd_search(db: &Database, query: &str, limit: usize) {
    let query_lower = query.to_lowercase();
    let mut results = Vec::new();

    for series in &db.series {
        for vol in &series.volumes {
            let title_lower = vol.title.to_lowercase();
            let body_lower = vol.body.to_lowercase();

            if title_lower.contains(&query_lower) || body_lower.contains(&query_lower) {
                let snippet = make_snippet(&vol.body, &query_lower, 80);
                results.push(SearchResult {
                    series_id: series.id.clone(),
                    series_name: series.name.clone(),
                    volume: vol.volume,
                    title: vol.title.clone(),
                    snippet,
                });
            }
        }
    }

    results.sort_by(|a, b| {
        a.series_id.cmp(&b.series_id).then(a.volume.cmp(&b.volume))
    });

    let total = results.len();
    if limit > 0 && results.len() > limit {
        results.truncate(limit);
    }

    let output = SearchOutput {
        query: query.to_string(),
        total,
        results,
    };
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}

fn make_snippet(body: &str, query_lower: &str, context_chars: usize) -> String {
    let body_lower = body.to_lowercase();
    if let Some(pos) = body_lower.find(query_lower) {
        let start = if pos > context_chars { pos - context_chars } else { 0 };
        let end = (pos + query_lower.len() + context_chars).min(body.len());
        let start = char_floor(body, start);
        let end = char_ceil(body, end);
        let mut snippet = String::new();
        if start > 0 {
            snippet.push_str("...");
        }
        snippet.push_str(&body[start..end]);
        if end < body.len() {
            snippet.push_str("...");
        }
        snippet
    } else {
        let end = body.len().min(160);
        let end = char_ceil(body, end);
        let mut snippet = body[..end].to_string();
        if end < body.len() {
            snippet.push_str("...");
        }
        snippet
    }
}

// --- toc command ---

#[derive(Serialize)]
struct TocOutput {
    series_id: String,
    series_name: String,
    total: usize,
    from: u64,
    to: u64,
    volumes: Vec<TocEntry>,
}

#[derive(Serialize)]
struct TocEntry {
    volume: u64,
    title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    audio_src: Option<String>,
}

fn cmd_toc(db: &Database, series_query: &str, from: Option<u64>, to: Option<u64>) {
    let series = find_series(db, series_query);

    let from_val = from.unwrap_or(1);
    let to_val = to.unwrap_or(u64::MAX);

    let volumes: Vec<TocEntry> = series
        .volumes
        .iter()
        .filter(|v| v.volume >= from_val && v.volume <= to_val)
        .map(|v| TocEntry {
            volume: v.volume,
            title: v.title.clone(),
            audio_src: v.media.first().map(|m| m.src.clone()),
        })
        .collect();

    let actual_from = volumes.first().map(|v| v.volume).unwrap_or(from_val);
    let actual_to = volumes.last().map(|v| v.volume).unwrap_or(to_val);

    let output = TocOutput {
        series_id: series.id.clone(),
        series_name: series.name.clone(),
        total: volumes.len(),
        from: actual_from,
        to: actual_to,
        volumes,
    };
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}

// --- shared helper ---

fn find_series<'a>(db: &'a Database, query: &str) -> &'a Series {
    match db.series.iter().find(|s| s.id == query || s.name.contains(query)) {
        Some(s) => s,
        None => {
            let output = serde_json::json!({"error": format!("series not found: {}", query)});
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
            std::process::exit(1);
        }
    }
}

fn vol_to_show(series: &Series, vol: &Volume) -> ShowOutput {
    ShowOutput {
        series_id: series.id.clone(),
        series_name: series.name.clone(),
        volume: vol.volume,
        title: vol.title.clone(),
        front: vol
            .front
            .iter()
            .map(|f| FrontMatter {
                title: f.title.clone(),
                value: f.value.clone(),
            })
            .collect(),
        media: vol
            .media
            .iter()
            .map(|m| MediaItem {
                media_type: m.media_type.clone(),
                src: m.src.clone(),
                duration: m.duration,
            })
            .collect(),
        body: vol.body.clone(),
    }
}

fn cmd_show(db: &Database, series_query: &str, volume_num: Option<u64>, from: Option<u64>, to: Option<u64>) {
    let series = find_series(db, series_query);

    if let Some(vn) = volume_num {
        let vol = series.volumes.iter().find(|v| v.volume == vn);
        let vol = match vol {
            Some(v) => v,
            None => {
                let output = serde_json::json!({
                    "error": format!("volume {} not found in series '{}'", vn, series.name)
                });
                println!("{}", serde_json::to_string_pretty(&output).unwrap());
                std::process::exit(1);
            }
        };
        let output = vol_to_show(series, vol);
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
        return;
    }

    let from_val = from.unwrap_or(1);
    let to_val = to.unwrap_or(u64::MAX);

    let vols: Vec<ShowOutput> = series
        .volumes
        .iter()
        .filter(|v| v.volume >= from_val && v.volume <= to_val)
        .map(|v| vol_to_show(series, v))
        .collect();

    if vols.is_empty() {
        let output = serde_json::json!({
            "error": format!("no volumes found in range {}-{} for series '{}'", from_val, to_val, series.name)
        });
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
        std::process::exit(1);
    }

    let output = serde_json::json!({
        "series_id": series.id,
        "series_name": series.name,
        "total": vols.len(),
        "from": vols.first().map(|v| v.volume).unwrap(),
        "to": vols.last().map(|v| v.volume).unwrap(),
        "volumes": vols
    });
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}

fn cmd_random(db: &Database, series_filter: Option<&str>) {
    let seed = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos();

    let candidates: Vec<(&Series, &Volume)> = if let Some(filter) = series_filter {
        db.series
            .iter()
            .filter(|s| s.id == filter || s.name.contains(filter))
            .flat_map(|s| s.volumes.iter().map(move |v| (s, v)))
            .collect()
    } else {
        db.series
            .iter()
            .flat_map(|s| s.volumes.iter().map(move |v| (s, v)))
            .collect()
    };

    if candidates.is_empty() {
        let output = serde_json::json!({"error": "no volumes found"});
        println!("{}", serde_json::to_string_pretty(&output).unwrap());
        std::process::exit(1);
    }

    let idx = (seed as usize) % candidates.len();
    let (series, vol) = candidates[idx];

    let output = ShowOutput {
        series_id: series.id.clone(),
        series_name: series.name.clone(),
        volume: vol.volume,
        title: vol.title.clone(),
        front: vol.front.iter().map(|f| FrontMatter { title: f.title.clone(), value: f.value.clone() }).collect(),
        media: vol.media.iter().map(|m| MediaItem { media_type: m.media_type.clone(), src: m.src.clone(), duration: m.duration }).collect(),
        body: if vol.body.len() > 500 {
            let end = char_ceil(&vol.body, 500);
            format!("{}...", &vol.body[..end])
        } else {
            vol.body.clone()
        },
    };
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}

// --- kejuan command: browse the outline tree ---

fn cmd_kejuan(db: &Database, query: Option<&str>, depth: Option<u32>) {
    let kejuan = match &db.kejuan {
        Some(k) => k,
        None => {
            let output = serde_json::json!({"error": "kejuan data not available"});
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
            std::process::exit(1);
        }
    };

    let max_depth = depth.unwrap_or(u32::MAX);

    let filtered: Vec<&KejuanNode> = if let Some(q) = query {
        let q_lower = q.to_lowercase();
        kejuan.nodes.iter()
            .filter(|n| {
                n.title.to_lowercase().contains(&q_lower)
                    || n.path.iter().any(|p| p.to_lowercase().contains(&q_lower))
            })
            .collect()
    } else {
        kejuan.nodes.iter()
            .filter(|n| n.depth <= max_depth)
            .collect()
    };

    // Build output with indented tree
    #[derive(Serialize)]
    struct KejuanOutput {
        total: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        query: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        max_depth: Option<u32>,
        nodes: Vec<KejuanNodeOutput>,
    }

    #[derive(Serialize)]
    struct KejuanNodeOutput {
        title: String,
        depth: u32,
        path: Vec<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        paragraph_range: Option<ParaRange>,
        #[serde(skip_serializing_if = "Option::is_none")]
        original_text: Option<String>,
    }

    let nodes: Vec<KejuanNodeOutput> = filtered.iter().map(|n| {
        // If searching, include the original text for matched nodes
        let original_text = if query.is_some() {
            n.paragraph_range.as_ref().and_then(|pr| {
                let texts: Vec<&str> = kejuan.paragraphs.iter()
                    .filter(|p| p.id >= pr.start && p.id <= pr.end)
                    .map(|p| p.text.as_str())
                    .collect();
                if texts.is_empty() { None } else {
                    let joined = texts.join("\n");
                    // Truncate to 500 chars for search results
                    if joined.len() > 500 {
                        let end = char_ceil(&joined, 500);
                        Some(format!("{}...", &joined[..end]))
                    } else {
                        Some(joined)
                    }
                }
            })
        } else {
            None
        };

        KejuanNodeOutput {
            title: n.title.clone(),
            depth: n.depth,
            path: n.path.clone(),
            paragraph_range: n.paragraph_range.clone(),
            original_text,
        }
    }).collect();

    let output = KejuanOutput {
        total: nodes.len(),
        query: query.map(|q| q.to_string()),
        max_depth: if query.is_none() && max_depth < u32::MAX { Some(max_depth) } else { None },
        nodes,
    };
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}

// --- kejuan text command: show original text for a kejuan section ---

fn cmd_kejuan_text(db: &Database, query: &str) {
    let kejuan = match &db.kejuan {
        Some(k) => k,
        None => {
            let output = serde_json::json!({"error": "kejuan data not available"});
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
            std::process::exit(1);
        }
    };

    let q_lower = query.to_lowercase();
    let node = kejuan.nodes.iter().find(|n| {
        n.title.to_lowercase().contains(&q_lower)
    });

    let node = match node {
        Some(n) => n,
        None => {
            let output = serde_json::json!({"error": format!("kejuan section not found: {}", query)});
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
            std::process::exit(1);
        }
    };

    let paragraphs: Vec<&KejuanParagraph> = if let Some(pr) = &node.paragraph_range {
        kejuan.paragraphs.iter()
            .filter(|p| p.id >= pr.start && p.id <= pr.end)
            .collect()
    } else {
        vec![]
    };

    #[derive(Serialize)]
    struct TextOutput {
        kejuan_title: String,
        path: Vec<String>,
        paragraph_count: usize,
        paragraphs: Vec<TextPara>,
    }
    #[derive(Serialize)]
    struct TextPara {
        id: u64,
        text: String,
        #[serde(rename = "type")]
        text_type: String,
        page: String,
    }

    let output = TextOutput {
        kejuan_title: node.title.clone(),
        path: node.path.clone(),
        paragraph_count: paragraphs.len(),
        paragraphs: paragraphs.iter().map(|p| TextPara {
            id: p.id,
            text: p.text.clone(),
            text_type: p.text_type.clone(),
            page: p.page.clone(),
        }).collect(),
    };
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}

// --- ref command: cross-reference guanghai ↔ shifu ---

fn cmd_ref(db: &Database, guanghai_vol: Option<u64>, shifu_query: Option<&str>) {
    let xref = match &db.xref {
        Some(x) => x,
        None => {
            let output = serde_json::json!({"error": "xref data not available"});
            println!("{}", serde_json::to_string_pretty(&output).unwrap());
            std::process::exit(1);
        }
    };

    let filtered: Vec<&XrefMatch> = xref.guanghai_to_shifu.iter()
        .filter(|m| {
            if let Some(vol) = guanghai_vol {
                if m.guanghai_vol != vol { return false; }
            }
            if let Some(q) = shifu_query {
                let q_lower = q.to_lowercase();
                if !m.shifu_tape.to_lowercase().contains(&q_lower)
                    && !m.shifu_kejuan.to_lowercase().contains(&q_lower)
                    && !m.quote.to_lowercase().contains(&q_lower)
                {
                    return false;
                }
            }
            true
        })
        .collect();

    #[derive(Serialize)]
    struct RefOutput {
        total: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        guanghai_volume: Option<u64>,
        #[serde(skip_serializing_if = "Option::is_none")]
        filter: Option<String>,
        refs: Vec<RefEntry>,
    }
    #[derive(Serialize)]
    struct RefEntry {
        guanghai_vol: u64,
        guanghai_title: String,
        quote_snippet: String,
        shifu_vol: u64,
        shifu_tape: String,
        shifu_kejuan: String,
        shifu_audio_src: String,
        score: f64,
    }

    // Look up titles and audio
    let guanghai = db.series.iter().find(|s| s.id == "guanghai");
    let guanglun = db.series.iter().find(|s| s.id == "guanglun");

    let refs: Vec<RefEntry> = filtered.iter().map(|m| {
        let gh_title = guanghai
            .and_then(|s| s.volumes.iter().find(|v| v.volume == m.guanghai_vol))
            .map(|v| v.title.clone())
            .unwrap_or_default();

        let shifu_audio = guanglun
            .and_then(|s| s.volumes.iter().find(|v| v.volume == m.shifu_vol))
            .and_then(|v| v.media.first())
            .map(|media| media.src.clone())
            .unwrap_or_default();

        let quote_snippet = if m.quote.len() > 100 {
            let end = char_ceil(&m.quote, 100);
            format!("{}...", &m.quote[..end])
        } else {
            m.quote.clone()
        };

        RefEntry {
            guanghai_vol: m.guanghai_vol,
            guanghai_title: gh_title,
            quote_snippet,
            shifu_vol: m.shifu_vol,
            shifu_tape: m.shifu_tape.clone(),
            shifu_kejuan: m.shifu_kejuan.clone(),
            shifu_audio_src: shifu_audio,
            score: m.score,
        }
    }).collect();

    let output = RefOutput {
        total: refs.len(),
        guanghai_volume: guanghai_vol,
        filter: shifu_query.map(|s| s.to_string()),
        refs,
    };
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}

// --- term command: aggregate all mentions of a term across series ---

fn cmd_term(db: &Database, term: &str, limit: usize) {
    let term_lower = term.to_lowercase();

    // Search across all series
    let mut mentions: Vec<serde_json::Value> = Vec::new();

    for series in &db.series {
        for vol in &series.volumes {
            let body_lower = vol.body.to_lowercase();
            if !body_lower.contains(&term_lower) {
                continue;
            }

            // Count occurrences
            let count = body_lower.matches(&term_lower).count();

            // Extract up to 3 snippets from this volume
            let mut snippets = Vec::new();
            let mut search_start = 0;
            while snippets.len() < 3 {
                if let Some(pos) = body_lower[search_start..].find(&term_lower) {
                    let abs_pos = search_start + pos;
                    let start = if abs_pos > 60 { abs_pos - 60 } else { 0 };
                    let end = (abs_pos + term.len() + 60).min(vol.body.len());
                    let start = char_floor(&vol.body, start);
                    let end = char_ceil(&vol.body, end);
                    let mut snippet = String::new();
                    if start > 0 { snippet.push_str("..."); }
                    snippet.push_str(&vol.body[start..end]);
                    if end < vol.body.len() { snippet.push_str("..."); }
                    snippets.push(snippet);
                    search_start = abs_pos + term.len();
                } else {
                    break;
                }
            }

            mentions.push(serde_json::json!({
                "series_id": series.id,
                "series_name": series.name,
                "volume": vol.volume,
                "title": vol.title,
                "occurrences": count,
                "snippets": snippets,
            }));
        }
    }

    // Sort: most occurrences first
    mentions.sort_by(|a, b| {
        b["occurrences"].as_u64().unwrap_or(0)
            .cmp(&a["occurrences"].as_u64().unwrap_or(0))
    });

    let total = mentions.len();
    if limit > 0 && mentions.len() > limit {
        mentions.truncate(limit);
    }

    // Also search kejuan for the term
    let kejuan_matches: Vec<serde_json::Value> = if let Some(kejuan) = &db.kejuan {
        kejuan.nodes.iter()
            .filter(|n| n.title.to_lowercase().contains(&term_lower))
            .map(|n| serde_json::json!({
                "title": n.title,
                "path": n.path,
                "paragraph_range": n.paragraph_range,
            }))
            .collect()
    } else {
        vec![]
    };

    let output = serde_json::json!({
        "term": term,
        "total_volumes_matched": total,
        "showing": mentions.len(),
        "kejuan_sections": kejuan_matches,
        "mentions": mentions,
    });
    println!("{}", serde_json::to_string_pretty(&output).unwrap());
}

fn print_help() {
    eprintln!("dacien-cli - 大慈恩寺学习资料查询工具");
    eprintln!();
    eprintln!("Usage:");
    eprintln!("  dacien-cli list                                       列出所有系列及讲次数量");
    eprintln!("  dacien-cli toc <series> [--from N] [--to M]           查看目录（标题列表）");
    eprintln!("  dacien-cli search <keyword> [--limit N]               全文搜索（标题+正文）");
    eprintln!("  dacien-cli show <series> [volume] [--from N] [--to M] 查看某一讲或某范围详情");
    eprintln!("  dacien-cli random [series]                            随机推荐一讲");
    eprintln!("  dacien-cli kejuan [keyword] [--depth N]               浏览广论科判大纲");
    eprintln!("  dacien-cli kejuan-text <科判名>                       查看科判对应的广论原文");
    eprintln!("  dacien-cli ref [--vol N] [--filter keyword]           广海明月↔师父手抄稿交叉引用");
    eprintln!("  dacien-cli term <名相> [--limit N]                    名相术语汇总（跨系列聚合）");
    eprintln!();
    eprintln!("Series IDs:");
    eprintln!("  guanghai   广海明月（真如老师）");
    eprintln!("  guanglun   菩提道次第广论手抄稿·南普陀版（日常法师/师父）");
    eprintln!("  nanshan    南山律在家备览略编手抄稿·1991年版（日常法师/师父）");
    eprintln!("  zhiguan    广论止观初探（真如老师）");
    eprintln!("  daocidi    道次第略义浅释（真如老师）");
    eprintln!("  biboshena  广论止观初探·毗钵舍那（真如老师）");
    eprintln!();
    eprintln!("Output: JSON format");
    eprintln!();
    eprintln!("Examples:");
    eprintln!("  dacien-cli list");
    eprintln!("  dacien-cli toc guanghai                        # 广海明月全部标题");
    eprintln!("  dacien-cli toc guanglun --from 1 --to 10       # 手抄稿前10讲标题");
    eprintln!("  dacien-cli search 菩提心");
    eprintln!("  dacien-cli search 皈依 --limit 5");
    eprintln!("  dacien-cli show guanghai 1");
    eprintln!("  dacien-cli show guanglun 16                    # 008B 手抄稿");
    eprintln!("  dacien-cli show guanghai --from 1 --to 3       # 第1-3讲详情");
    eprintln!("  dacien-cli random guanghai");
    eprintln!("  dacien-cli kejuan                              # 科判全览（顶层）");
    eprintln!("  dacien-cli kejuan --depth 2                    # 科判前2层");
    eprintln!("  dacien-cli kejuan 皈依                         # 搜索含「皈依」的科判节点");
    eprintln!("  dacien-cli kejuan-text 通达一切圣教无违殊胜    # 查看该科判的广论原文");
    eprintln!("  dacien-cli ref --vol 1                         # 广海明月第1讲引用了哪些师父手抄稿");
    eprintln!("  dacien-cli ref --filter 皈依                   # 找师父讲皈依的交叉引用");
    eprintln!("  dacien-cli term 菩提心                         # 「菩提心」在所有系列中的出现汇总");
    eprintln!("  dacien-cli term 暇满 --limit 10                # 前10个最相关讲次");
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    if args.is_empty() {
        print_help();
        std::process::exit(1);
    }

    match args[0].as_str() {
        "--help" | "-h" => print_help(),
        "list" => {
            let db = load_db();
            cmd_list(&db);
        }
        "toc" => {
            if args.len() < 2 {
                eprintln!("Error: toc requires a <series> argument");
                std::process::exit(1);
            }
            let series = &args[1];
            let mut from: Option<u64> = None;
            let mut to: Option<u64> = None;
            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--from" if i + 1 < args.len() => { from = args[i + 1].parse().ok(); i += 2; }
                    "--to" if i + 1 < args.len() => { to = args[i + 1].parse().ok(); i += 2; }
                    _ => { i += 1; }
                }
            }
            let db = load_db();
            cmd_toc(&db, series, from, to);
        }
        "search" => {
            if args.len() < 2 {
                eprintln!("Error: search requires a keyword argument");
                std::process::exit(1);
            }
            let query = &args[1];
            let mut limit: usize = 20;
            if args.len() >= 4 && args[2] == "--limit" {
                limit = args[3].parse().unwrap_or(20);
            }
            let db = load_db();
            cmd_search(&db, query, limit);
        }
        "show" => {
            if args.len() < 2 {
                eprintln!("Error: show requires <series> argument");
                std::process::exit(1);
            }
            let series = &args[1];
            let mut volume_num: Option<u64> = None;
            let mut from: Option<u64> = None;
            let mut to: Option<u64> = None;
            let mut i = 2;
            while i < args.len() {
                match args[i].as_str() {
                    "--from" if i + 1 < args.len() => { from = args[i + 1].parse().ok(); i += 2; }
                    "--to" if i + 1 < args.len() => { to = args[i + 1].parse().ok(); i += 2; }
                    _ => {
                        if volume_num.is_none() {
                            volume_num = args[i].parse().ok();
                        }
                        i += 1;
                    }
                }
            }
            let db = load_db();
            if from.is_some() || to.is_some() {
                cmd_show(&db, series, None, from, to);
            } else if let Some(vn) = volume_num {
                cmd_show(&db, series, Some(vn), None, None);
            } else {
                eprintln!("Error: show requires a <volume> number or --from/--to range");
                std::process::exit(1);
            }
        }
        "random" => {
            let filter = args.get(1).map(|s| s.as_str());
            let db = load_db();
            cmd_random(&db, filter);
        }
        "kejuan" => {
            let mut query: Option<String> = None;
            let mut depth: Option<u32> = None;
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--depth" if i + 1 < args.len() => { depth = args[i + 1].parse().ok(); i += 2; }
                    _ => {
                        if query.is_none() && !args[i].starts_with('-') {
                            query = Some(args[i].clone());
                        }
                        i += 1;
                    }
                }
            }
            let db = load_db();
            cmd_kejuan(&db, query.as_deref(), depth);
        }
        "kejuan-text" => {
            if args.len() < 2 {
                eprintln!("Error: kejuan-text requires a <科判名> argument");
                std::process::exit(1);
            }
            let query = &args[1];
            let db = load_db();
            cmd_kejuan_text(&db, query);
        }
        "ref" => {
            let mut vol: Option<u64> = None;
            let mut filter: Option<String> = None;
            let mut i = 1;
            while i < args.len() {
                match args[i].as_str() {
                    "--vol" if i + 1 < args.len() => { vol = args[i + 1].parse().ok(); i += 2; }
                    "--filter" if i + 1 < args.len() => { filter = Some(args[i + 1].clone()); i += 2; }
                    _ => { i += 1; }
                }
            }
            let db = load_db();
            cmd_ref(&db, vol, filter.as_deref());
        }
        "term" => {
            if args.len() < 2 {
                eprintln!("Error: term requires a <名相> argument");
                std::process::exit(1);
            }
            let term = &args[1];
            let mut limit: usize = 20;
            if args.len() >= 4 && args[2] == "--limit" {
                limit = args[3].parse().unwrap_or(20);
            }
            let db = load_db();
            cmd_term(&db, term, limit);
        }
        _ => {
            eprintln!("Unknown command: {}", args[0]);
            print_help();
            std::process::exit(1);
        }
    }
}

fn char_floor(s: &str, index: usize) -> usize {
    if index >= s.len() { return s.len(); }
    let mut i = index;
    while i > 0 && !s.is_char_boundary(i) { i -= 1; }
    i
}

fn char_ceil(s: &str, index: usize) -> usize {
    if index >= s.len() { return s.len(); }
    let mut i = index;
    while i < s.len() && !s.is_char_boundary(i) { i += 1; }
    i
}
