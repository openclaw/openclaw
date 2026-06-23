//! OpenClaw Launcher - macOS 启动器
//!
//! 使用责任链模式自动检测和安装环境
//! 功能：
//! 1. 自动检测环境（Node.js, pnpm, git）
//! 2. 自动安装缺失组件（使用 Homebrew）
//! 3. 自动启动 gateway
//! 4. 启动 TUI/WebUI
//! 5. 获取 gateway 令牌并自动打开浏览器

use std::env;
use std::fs;
use std::io::{self, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{self, Command};
use std::thread;
use std::time::Duration;

// 地区配置
struct RegionConfig {
    code: String,
    name: String,
    npm_mirror: String,
}

// 环境状态
#[derive(Debug)]
struct EnvStatus {
    node_version: Option<String>,
    pnpm_version: Option<String>,
    git_version: Option<String>,
}

// 责任链：环境安装器
trait EnvInstaller {
    fn name(&self) -> &str;
    fn is_installed(&self) -> bool;
    fn install(&self, region: &RegionConfig) -> bool;
}

// Node.js 安装器
struct NodeInstaller;
impl EnvInstaller for NodeInstaller {
    fn name(&self) -> &str { "Node.js" }
    fn is_installed(&self) -> bool {
        check_command("node", &["-v"]).is_some()
    }
    fn install(&self, _region: &RegionConfig) -> bool {
        println!("  正在安装 Node.js...");
        
        // 尝试 Homebrew
        if check_command("brew", &["--version"]).is_some() {
            println!("  使用 Homebrew 安装...");
            return Command::new("brew")
                .args(["install", "node@22"])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
        }
        
        false
    }
}

// pnpm 安装器
struct PnpmInstaller;
impl EnvInstaller for PnpmInstaller {
    fn name(&self) -> &str { "pnpm" }
    fn is_installed(&self) -> bool {
        check_command("pnpm", &["-v"]).is_some()
    }
    fn install(&self, region: &RegionConfig) -> bool {
        println!("  正在安装 pnpm...");
        
        // 设置镜像
        if region.code == "cn" {
            let _ = Command::new("npm")
                .args(["config", "set", "registry", &region.npm_mirror])
                .status();
        }
        
        Command::new("npm")
            .args(["install", "-g", "pnpm"])
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
}

// Git 安装器
struct GitInstaller;
impl EnvInstaller for GitInstaller {
    fn name(&self) -> &str { "Git" }
    fn is_installed(&self) -> bool {
        check_command("git", &["--version"]).is_some()
    }
    fn install(&self, _region: &RegionConfig) -> bool {
        println!("  正在安装 Git...");
        
        if check_command("brew", &["--version"]).is_some() {
            return Command::new("brew")
                .args(["install", "git"])
                .status()
                .map(|s| s.success())
                .unwrap_or(false);
        }
        
        false
    }
}

// 环境管理器
struct EnvManager {
    installers: Vec<Box<dyn EnvInstaller>>,
}

impl EnvManager {
    fn new() -> Self {
        Self {
            installers: vec![
                Box::new(NodeInstaller),
                Box::new(PnpmInstaller),
                Box::new(GitInstaller),
            ],
        }
    }
    
    fn check_and_install(&self, region: &RegionConfig) -> EnvStatus {
        let mut status = EnvStatus {
            node_version: None,
            pnpm_version: None,
            git_version: None,
        };
        
        for installer in &self.installers {
            if installer.is_installed() {
                println!("  [✓] {} 已安装", installer.name());
                match installer.name() {
                    "Node.js" => status.node_version = check_command("node", &["-v"]),
                    "pnpm" => status.pnpm_version = check_command("pnpm", &["-v"]),
                    "Git" => status.git_version = check_command("git", &["--version"]),
                    _ => {}
                }
            } else {
                println!("  [!] {} 未安装，正在自动安装...", installer.name());
                if installer.install(region) {
                    println!("  [✓] {} 安装成功", installer.name());
                    match installer.name() {
                        "Node.js" => status.node_version = check_command("node", &["-v"]),
                        "pnpm" => status.pnpm_version = check_command("pnpm", &["-v"]),
                        "Git" => status.git_version = check_command("git", &["--version"]),
                        _ => {}
                    }
                } else {
                    println!("  [✗] {} 安装失败", installer.name());
                }
            }
        }
        
        status
    }
}

/// 查找项目根目录
fn find_project_root() -> Option<PathBuf> {
    let exe_path = env::current_exe().ok()?;
    let mut dir = exe_path.parent()?;

    // macOS .app 结构：Contents/MacOS/openclaw-launcher
    // 需要向上查找 3 级到 .app 根目录，然后再找 Resources
    for _ in 0..3 {
        if dir.join("openclaw.mjs").exists() {
            return Some(dir.to_path_buf());
        }
        dir = dir.parent()?;
    }

    // 尝试 Resources 目录
    let exe_path = env::current_exe().ok()?;
    let resources = exe_path.parent()?.parent()?.join("Resources");
    if resources.join("openclaw.mjs").exists() {
        return Some(resources);
    }

    None
}

/// 检测系统地区
fn detect_region() -> RegionConfig {
    if let Ok(output) = Command::new("defaults")
        .args(["read", "-g", "AppleLocale"])
        .output()
    {
        let locale = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if locale.starts_with("zh") {
            return RegionConfig {
                code: "cn".to_string(),
                name: "中国大陆".to_string(),
                npm_mirror: "https://registry.npmmirror.com".to_string(),
            };
        }
    }

    RegionConfig {
        code: "en".to_string(),
        name: "English".to_string(),
        npm_mirror: "https://registry.npmjs.org".to_string(),
    }
}

/// 检查命令是否可用
fn check_command(cmd: &str, args: &[&str]) -> Option<String> {
    Command::new(cmd)
        .args(args)
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
}

/// 检查 gateway 端口
fn is_gateway_running(port: u16) -> bool {
    let addr = format!("127.0.0.1:{}", port);
    match addr.parse() {
        Ok(socket_addr) => {
            TcpStream::connect_timeout(&socket_addr, Duration::from_millis(500)).is_ok()
        }
        Err(_) => false,
    }
}

/// 启动 gateway
fn start_gateway(project_root: &PathBuf) -> bool {
    println!("  正在启动 gateway...");

    let openclaw_mjs = project_root.join("openclaw.mjs");
    let mut cmd = Command::new("node");
    cmd.arg(&openclaw_mjs)
        .arg("gateway")
        .current_dir(project_root);

    // macOS: 使用 nohup 后台运行
    match cmd.spawn() {
        Ok(_) => true,
        Err(e) => {
            eprintln!("  启动失败：{}", e);
            false
        }
    }
}

/// 等待 gateway 就绪
fn wait_for_gateway(port: u16, timeout_secs: u32) -> bool {
    let start = std::time::Instant::now();
    let timeout = Duration::from_secs(timeout_secs as u64);

    while start.elapsed() < timeout {
        if is_gateway_running(port) {
            return true;
        }
        thread::sleep(Duration::from_millis(500));
    }

    false
}

/// 打开浏览器
fn open_browser(url: &str) -> bool {
    Command::new("open").arg(url).spawn().is_ok()
}

/// 获取配置文件路径
fn get_config_path() -> PathBuf {
    let exe_path = env::current_exe().unwrap_or_else(|_| PathBuf::from("openclaw-launcher"));
    exe_path.parent()
        .unwrap_or_else(|| std::path::Path::new("."))
        .join("openclaw-launcher.conf")
}

/// 读取配置文件
fn read_config() -> (Option<String>, Option<String>) {
    let config_path = get_config_path();
    if !config_path.exists() {
        return (None, None);
    }
    
    let content = fs::read_to_string(&config_path).unwrap_or_default();
    let mut token = None;
    let mut ws_url = None;
    
    for line in content.lines() {
        let line = line.trim();
        if line.starts_with("token=") {
            token = Some(line[6..].to_string());
        } else if line.starts_with("ws_url=") {
            ws_url = Some(line[7..].to_string());
        }
    }
    
    (token, ws_url)
}

/// 保存配置到文件
fn save_config(token: &str, ws_url: &str) {
    let config_path = get_config_path();
    let content = format!("token={}\nws_url={}\n", token, ws_url);
    if let Err(e) = fs::write(&config_path, content) {
        eprintln!("  警告：无法保存配置：{}", e);
    } else {
        println!("  配置已保存到：{}", config_path.display());
    }
}

/// 获取 gateway 令牌和 WebSocket URL
fn get_gateway_token(project_root: &PathBuf) -> Option<(String, String)> {
    println!("  正在获取 gateway 令牌...");
    
    let openclaw_mjs = project_root.join("openclaw.mjs");
    
    let output = Command::new("node")
        .arg(&openclaw_mjs)
        .arg("dashboard")
        .arg("--no-open")
        .current_dir(project_root)
        .output()
        .ok()?;
    
    if !output.status.success() {
        eprintln!("  获取令牌失败");
        return None;
    }
    
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}{}", stdout, stderr);
    
    // 从剪贴板读取完整 URL（包含 token）
    let clipboard_url = Command::new("osascript")
        .args(["-e", "get the clipboard"])
        .output()
        .ok()
        .and_then(|o| {
            let text = String::from_utf8_lossy(&o.stdout).trim().to_string();
            if text.starts_with("http://") || text.starts_with("https://") {
                Some(text)
            } else {
                None
            }
        });
    
    let mut token = None;
    let mut ws_url = None;
    
    if let Some(clipboard_text) = clipboard_url {
        println!("  从剪贴板获取 URL");
        if clipboard_text.contains("token=") {
            if let Some(token_start) = clipboard_text.find("token=") {
                let token_value = clipboard_text[token_start + 6..].split('&').next().unwrap_or("");
                token = Some(token_value.to_string());
            }
        }
        ws_url = Some(clipboard_text.split('?').next().unwrap_or(&clipboard_text).to_string());
    }
    
    if token.is_none() || ws_url.is_none() {
        for line in combined.lines() {
            let line = line.trim();
            if line.contains("Dashboard URL:") || line.starts_with("http://") || line.starts_with("ws://") {
                if let Some(url_start) = line.find("http://") {
                    let url = line[url_start..].split_whitespace().next().unwrap_or("");
                    ws_url = Some(url.to_string());
                }
            }
            if line.contains("token=") {
                if let Some(token_start) = line.find("token=") {
                    let token_value = line[token_start + 6..].split_whitespace().next().unwrap_or("");
                    token = Some(token_value.to_string());
                }
            }
        }
    }
    
    match (token, ws_url) {
        (Some(t), Some(url)) => {
            println!("  令牌：{}...", &t[..std::cmp::min(t.len(), 8)]);
            println!("  URL：{}", url);
            Some((t, url))
        }
        (None, Some(url)) => {
            println!("  URL：{} (无令牌)", url);
            Some((String::new(), url))
        }
        _ => None,
    }
}

/// 自动安装依赖
fn install_deps(project_root: &PathBuf) -> bool {
    println!("  正在安装项目依赖...");
    Command::new("pnpm")
        .arg("install")
        .current_dir(project_root)
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// 显示菜单
fn show_menu(region: &RegionConfig, env: &EnvStatus) {
    println!();
    println!("╔════════════════════════════════════════════════════════════╗");
    println!("║                    OpenClaw Launcher                       ║");
    println!("╠════════════════════════════════════════════════════════════╣");
    println!("║  地区：{:<52} ║", region.name);
    println!("║  Node.js: {:<48} ║", env.node_version.as_deref().unwrap_or("未安装"));
    println!("║  pnpm: {:<51} ║", env.pnpm_version.as_deref().unwrap_or("未安装"));
    println!("║  Git: {:<52} ║", env.git_version.as_deref().unwrap_or("未安装"));
    println!("╠════════════════════════════════════════════════════════════╣");
    println!("║                                                            ║");
    println!("║  请选择操作：                                               ║");
    println!("║                                                            ");
    println!("║  [1] 启动 TUI 终端界面                                     ║");
    println!("║  [2] 启动 WebUI 网页界面                                   ║");
    println!("║  [3] 检查并更新代码                                        ║");
    println!("║  [4] 重新检测并安装环境                                    ║");
    println!("║  [0] 退出                                                  ║");
    println!("║                                                            ║");
    println!("════════════════════════════════════════════════════════════╝");
    println!();
    print!("请输入选项 (0-4): ");
    io::stdout().flush().unwrap();
}

/// 读取用户输入
fn read_input() -> String {
    let mut input = String::new();
    io::stdin().read_line(&mut input).unwrap_or(0);
    input.trim().to_string()
}

/// 更新代码
fn update_code(project_root: &PathBuf, region: &RegionConfig) {
    println!();
    println!("正在检查更新...");

    let git_status = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(project_root)
        .output()
        .ok();

    if let Some(status) = git_status {
        if !status.stdout.is_empty() {
            println!("检测到本地修改，请先提交或暂存更改");
            return;
        }
    }

    if region.code == "cn" {
        println!("使用 GitHub 镜像加速...");
        let _ = Command::new("git")
            .args(["remote", "set-url", "origin", "https://ghproxy.com/https://github.com/openclaw/openclaw.git"])
            .current_dir(project_root)
            .status();
    }

    println!("正在拉取最新代码...");
    let result = Command::new("git")
        .args(["pull", "--rebase", "origin", "main"])
        .current_dir(project_root)
        .status();

    match result {
        Ok(s) if s.success() => {
            println!("代码更新成功！");
            println!("正在安装依赖...");
            install_deps(project_root);
        }
        _ => {
            println!("更新失败，请检查网络连接");
        }
    }
}

/// 启动 TUI
fn start_tui(project_root: &PathBuf) {
    let gateway_port = 18789;

    println!();
    println!("正在启动 TUI...");

    if !is_gateway_running(gateway_port) {
        println!("Gateway 未运行，正在启动...");
        
        if start_gateway(project_root) {
            println!("等待 gateway 就绪 (最多 30 秒)...");
            if wait_for_gateway(gateway_port, 30) {
                println!("✓ Gateway 已启动");
            } else {
                eprintln!(" Gateway 启动超时");
                return;
            }
        } else {
            eprintln!("✗ 无法启动 gateway");
            return;
        }
    } else {
        println!("✓ Gateway 已在运行");
    }

    println!();
    println!("正在启动 TUI 界面...");
    let openclaw_mjs = project_root.join("openclaw.mjs");
    let _ = Command::new("node")
        .arg(&openclaw_mjs)
        .arg("tui")
        .current_dir(project_root)
        .status();
}

/// 启动 WebUI
fn start_webui(project_root: &PathBuf) {
    let gateway_port = 18789;

    println!();
    println!("正在启动 WebUI...");

    if !is_gateway_running(gateway_port) {
        println!("Gateway 未运行，正在启动...");
        
        if start_gateway(project_root) {
            println!("等待 gateway 就绪 (最多 30 秒)...");
            if wait_for_gateway(gateway_port, 30) {
                println!("✓ Gateway 已启动");
            } else {
                eprintln!(" Gateway 启动超时");
                return;
            }
        } else {
            eprintln!("✗ 无法启动 gateway");
            return;
        }
    } else {
        println!("✓ Gateway 已在运行");
    }

    let (token, full_url) = match read_config() {
        (Some(token), Some(url)) => {
            println!("✓ 使用已保存的令牌");
            (token, url)
        }
        _ => {
            match get_gateway_token(project_root) {
                Some((token, url)) => {
                    save_config(&token, &url);
                    (token, url)
                }
                None => {
                    eprintln!("  无法获取令牌，使用基础 URL");
                    let url = format!("http://127.0.0.1:{}", gateway_port);
                    (String::new(), url)
                }
            }
        }
    };

    let browser_url = if !token.is_empty() && !full_url.contains("token=") {
        if full_url.contains("?") {
            format!("{}&token={}", full_url, token)
        } else {
            format!("{}?token={}", full_url, token)
        }
    } else {
        full_url.clone()
    };

    println!("正在打开浏览器...");
    
    if open_browser(&browser_url) {
        println!("✓ 浏览器已打开");
        println!("  URL: {}", browser_url);
    } else {
        eprintln!(" 无法打开浏览器");
        eprintln!("请手动访问：{}", browser_url);
    }
    
    println!();
    println!("按 Enter 键返回菜单...");
    read_input();
}

fn main() {
    let region = detect_region();
    let env_manager = EnvManager::new();
    
    let args: Vec<String> = env::args().skip(1).collect();

    let project_root = match find_project_root() {
        Some(root) => root,
        None => {
            eprintln!("错误：无法找到项目根目录");
            process::exit(1);
        }
    };

    // 命令行模式
    if !args.is_empty() {
        println!("OpenClaw Launcher - 自动模式");
        println!();
        
        println!("正在检测环境...");
        let env = env_manager.check_and_install(&region);
        
        if env.node_version.is_none() {
            eprintln!("错误：Node.js 安装失败");
            process::exit(1);
        }
        
        println!("Node.js 版本：{}", env.node_version.as_ref().unwrap());
        
        match args[0].as_str() {
            "tui" => {
                install_deps(&project_root);
                start_tui(&project_root);
            }
            "webui" => {
                install_deps(&project_root);
                start_webui(&project_root);
            }
            "--update" | "-u" => update_code(&project_root, &region),
            "--help" | "-h" => {
                println!("用法:");
                println!("  openclaw-launcher           显示交互式菜单");
                println!("  openclaw-launcher tui       启动 TUI 界面");
                println!("  openclaw-launcher webui     启动 WebUI");
                println!("  openclaw-launcher --update  更新代码");
            }
            _ => {
                eprintln!("未知命令：{}", args[0]);
                process::exit(1);
            }
        }
        return;
    }

    // 交互式菜单模式
    println!("OpenClaw Launcher - 自动环境检测");
    println!();
    println!("正在检测环境...");
    let mut env = env_manager.check_and_install(&region);
    
    if env.node_version.is_none() {
        eprintln!();
        eprintln!("错误：Node.js 安装失败，请手动安装");
        eprintln!("下载地址：https://nodejs.org/");
        process::exit(1);
    }

    loop {
        show_menu(&region, &env);
        let input = read_input();
        
        match input.as_str() {
            "0" => {
                println!("再见！");
                break;
            }
            "1" => {
                start_tui(&project_root);
            }
            "2" => {
                start_webui(&project_root);
            }
            "3" => {
                if env.git_version.is_some() {
                    update_code(&project_root, &region);
                } else {
                    println!("Git 未安装，无法更新代码");
                }
            }
            "4" => {
                println!();
                println!("重新检测环境...");
                env = env_manager.check_and_install(&region);
            }
            _ => {
                println!("无效选项，请重新输入");
            }
        }
    }
}
