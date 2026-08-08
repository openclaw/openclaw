//! OpenClaw Launcher - 交互式启动菜单
//!
//! 薄包装器，委托给现有的 openclaw CLI 命令：
//! - `openclaw tui` / `openclaw terminal` - 终端界面
//! - `openclaw dashboard` - WebUI（自动处理 token）
//! - `openclaw update` - 更新
//! - `openclaw gateway start/install` - Gateway 服务管理
//!
//! 不重复现有功能，不存储敏感信息，不执行破坏性操作。

use std::env;
use std::io::{self, Write};
use std::path::PathBuf;
use std::process::{self, Command};

/// 查找 openclaw CLI 可执行文件
fn find_openclaw_cli() -> Option<PathBuf> {
    // 优先使用 PATH 中的 openclaw
    if let Ok(output) = Command::new("which")
        .arg("openclaw")
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }

    // 尝试 pnpm openclaw
    if let Ok(output) = Command::new("pnpm")
        .args(["bin", "openclaw"])
        .output()
    {
        if output.status.success() {
            let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
            if !path.is_empty() {
                return Some(PathBuf::from(path));
            }
        }
    }

    // 尝试项目根目录的 openclaw.mjs
    let exe_path = env::current_exe().ok()?;
    let mut dir = exe_path.parent()?;
    for _ in 0..5 {
        let candidate = dir.join("openclaw.mjs");
        if candidate.exists() {
            return Some(candidate);
        }
        dir = dir.parent()?;
    }

    None
}

/// 检查 openclaw CLI 是否可用
fn is_openclaw_available(cli_path: &PathBuf) -> bool {
    let (cmd, args) = if cli_path.to_string_lossy().ends_with(".mjs") {
        (
            "node".to_string(),
            vec![cli_path.to_string_lossy().to_string(), "--version".to_string()],
        )
    } else {
        (
            cli_path.to_string_lossy().to_string(),
            vec!["--version".to_string()],
        )
    };

    Command::new(&cmd)
        .args(&args)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// 运行 openclaw 命令
fn run_openclaw(cli_path: &PathBuf, args: &[&str]) -> bool {
    let (cmd, cmd_args) = if cli_path.to_string_lossy().ends_with(".mjs") {
        let mut full_args = vec![cli_path.to_string_lossy().to_string()];
        full_args.extend(args.iter().map(|s| s.to_string()));
        ("node".to_string(), full_args)
    } else {
        (
            cli_path.to_string_lossy().to_string(),
            args.iter().map(|s| s.to_string()).collect(),
        )
    };

    match Command::new(&cmd).args(&cmd_args).status() {
        Ok(status) => status.success(),
        Err(e) => {
            eprintln!("  执行失败：{}", e);
            false
        }
    }
}

/// 检查 gateway 是否运行
fn is_gateway_running() -> bool {
    Command::new("curl")
        .args(["-s", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:18789/health"])
        .output()
        .map(|o| {
            let code = String::from_utf8_lossy(&o.stdout);
            code.trim() == "200"
        })
        .unwrap_or(false)
}

/// 启动 gateway（使用 openclaw gateway start）
fn start_gateway(cli_path: &PathBuf) -> bool {
    println!("  正在启动 gateway 服务...");
    run_openclaw(cli_path, &["gateway", "start"])
}

/// 安装 gateway 服务（launchd/systemd/schtasks）
fn install_gateway_service(cli_path: &PathBuf) -> bool {
    println!("  正在安装 gateway 服务...");
    run_openclaw(cli_path, &["gateway", "install"])
}

/// 打开 WebUI（使用 openclaw dashboard）
fn open_webui(cli_path: &PathBuf) {
    println!();
    println!("正在打开 WebUI...");

    // 检查 gateway 是否运行
    if !is_gateway_running() {
        println!("Gateway 未运行，正在启动...");
        if !start_gateway(cli_path) {
            eprintln!("  Gateway 启动失败，请手动运行: openclaw gateway start");
            return;
        }
        println!("  等待 gateway 就绪...");
        std::thread::sleep(std::time::Duration::from_secs(3));
    }

    // 使用 openclaw dashboard 打开浏览器（自动处理 token）
    println!("  正在打开浏览器...");
    if run_openclaw(cli_path, &["dashboard"]) {
        println!("  ✓ WebUI 已打开");
    } else {
        eprintln!("  ✗ 打开失败，请手动运行: openclaw dashboard");
    }

    println!();
    println!("按 Enter 键返回菜单...");
    let mut input = String::new();
    io::stdin().read_line(&mut input).unwrap_or(0);
}

/// 启动 TUI
fn start_tui(cli_path: &PathBuf) {
    println!();
    println!("正在启动 TUI...");

    // 检查 gateway 是否运行
    if !is_gateway_running() {
        println!("Gateway 未运行，正在启动...");
        if !start_gateway(cli_path) {
            eprintln!("  Gateway 启动失败，请手动运行: openclaw gateway start");
            return;
        }
        println!("  等待 gateway 就绪...");
        std::thread::sleep(std::time::Duration::from_secs(3));
    }

    // 使用 openclaw tui
    run_openclaw(cli_path, &["tui"]);
}

/// 更新（使用 openclaw update）
fn update(cli_path: &PathBuf) {
    println!();
    println!("正在检查更新...");
    run_openclaw(cli_path, &["update"]);
}

/// 显示菜单
fn show_menu(openclaw_version: &str) {
    println!();
    println!("╔════════════════════════════════════════════════════════════╗");
    println!("║                    OpenClaw Launcher                       ║");
    println!("════════════════════════════════════════════════════════════╣");
    println!("║  OpenClaw: {:<45} ║", openclaw_version);
    println!("║  Gateway:  {:<45} ║", if is_gateway_running() { "运行中" } else { "未运行" });
    println!("════════════════════════════════════════════════════════════╣");
    println!("║                                                            ║");
    println!("║  请选择操作：                                               ║");
    println!("║                                                            ║");
    println!("║  [1] 启动 TUI 终端界面     (openclaw tui)                  ║");
    println!("║  [2] 启动 WebUI 网页界面   (openclaw dashboard)            ║");
    println!("║  [3] 检查并更新            (openclaw update)               ║");
    println!("║  [4] Gateway 服务管理      (openclaw gateway)              ║");
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

/// Gateway 服务管理子菜单
fn gateway_menu(cli_path: &PathBuf) {
    loop {
        println!();
        println!("╔════════════════════════════════════════════════════════════╗");
        println!("║                  Gateway 服务管理                          ║");
        println!("╠════════════════════════════════════════════════════════════╣");
        println!("║  状态：{:<50} ║", if is_gateway_running() { "运行中" } else { "未运行" });
        println!("════════════════════════════════════════════════════════════╣");
        println!("║                                                            ║");
        println!("║  [1] 查看状态          (openclaw gateway status)           ║");
        println!("║  [2] 启动服务          (openclaw gateway start)            ║");
        println!("║  [3] 停止服务          (openclaw gateway stop)             ║");
        println!("║  [4] 重启服务          (openclaw gateway restart)          ║");
        println!("║  [5] 安装服务          (openclaw gateway install)          ║");
        println!("║  [6] 卸载服务          (openclaw gateway uninstall)        ║");
        println!("║  [0] 返回主菜单                                            ║");
        println!("║                                                            ║");
        println!("════════════════════════════════════════════════════════════╝");
        println!();
        print!("请输入选项 (0-6): ");
        io::stdout().flush().unwrap();

        let input = read_input();
        match input.as_str() {
            "0" => break,
            "1" => { run_openclaw(cli_path, &["gateway", "status"]); }
            "2" => { run_openclaw(cli_path, &["gateway", "start"]); }
            "3" => { run_openclaw(cli_path, &["gateway", "stop"]); }
            "4" => { run_openclaw(cli_path, &["gateway", "restart"]); }
            "5" => { install_gateway_service(cli_path); }
            "6" => { run_openclaw(cli_path, &["gateway", "uninstall"]); }
            _ => { println!("无效选项"); }
        }
    }
}

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();

    // 查找 openclaw CLI
    let cli_path = match find_openclaw_cli() {
        Some(path) => path,
        None => {
            eprintln!("错误：未找到 openclaw CLI");
            eprintln!("请确保已安装 openclaw: npm install -g openclaw@latest");
            process::exit(1);
        }
    };

    // 获取版本
    let version = Command::new("node")
        .args([&cli_path.to_string_lossy(), "--version"])
        .output()
        .ok()
        .and_then(|o| {
            if o.status.success() {
                Some(String::from_utf8_lossy(&o.stdout).trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| "unknown".to_string());

    // 命令行模式
    if !args.is_empty() {
        match args[0].as_str() {
            "tui" => {
                if !is_gateway_running() {
                    println!("Gateway 未运行，正在启动...");
                    start_gateway(&cli_path);
                    std::thread::sleep(std::time::Duration::from_secs(3));
                }
                run_openclaw(&cli_path, &["tui"]);
            }
            "webui" | "dashboard" => {
                open_webui(&cli_path);
            }
            "update" | "--update" | "-u" => {
                update(&cli_path);
            }
            "gateway" => {
                if args.len() > 1 {
                    // 保留 "gateway" 前缀: openclaw-launcher gateway start -> openclaw gateway start
                    let mut gw_args = vec!["gateway"];
                    gw_args.extend(args[1..].iter().map(|s| s.as_str()).collect::<Vec<&str>>());
                    run_openclaw(&cli_path, &gw_args);
                } else {
                    gateway_menu(&cli_path);
                }
            }
            "--help" | "-h" | "help" => {
                println!("OpenClaw Launcher - 交互式启动菜单");
                println!();
                println!("用法:");
                println!("  openclaw-launcher              显示交互式菜单");
                println!("  openclaw-launcher tui          启动 TUI 界面");
                println!("  openclaw-launcher webui        启动 WebUI");
                println!("  openclaw-launcher update       检查并更新");
                println!("  openclaw-launcher gateway      Gateway 服务管理");
                println!();
                println!("所有命令委托给现有的 openclaw CLI，不重复现有功能。");
            }
            _ => {
                // 透传所有其他参数给 openclaw CLI
                let passthrough: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
                run_openclaw(&cli_path, &passthrough);
            }
        }
        return;
    }

    // 交互式菜单模式
    println!("OpenClaw Launcher");
    println!("版本：{}", version);

    loop {
        show_menu(&version);
        let input = read_input();

        match input.as_str() {
            "0" => {
                println!("再见！");
                break;
            }
            "1" => {
                start_tui(&cli_path);
            }
            "2" => {
                open_webui(&cli_path);
            }
            "3" => {
                update(&cli_path);
            }
            "4" => {
                gateway_menu(&cli_path);
            }
            _ => {
                println!("无效选项，请重新输入");
            }
        }
    }
}
