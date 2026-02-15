# calc-cli（计算器）

高精度数学表达式计算器（Rust 静态二进制）。源码在 `cli/calc-cli/`。

## 功能

- 支持 `+ - * / % ^` 和括号，正确处理运算优先级
- 输出 JSON 格式：`{"expression":"2+3*4","result":14}`
- 纯静态编译，无任何运行时依赖，仅 ~460KB

## 本地交叉编译（Windows → Linux 静态二进制）

```bash
# 安装 musl target（仅首次）
rustup target add x86_64-unknown-linux-musl

# 交叉编译
$env:CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER='rust-lld'
cargo build --release --target x86_64-unknown-linux-musl --manifest-path cli/calc-cli/Cargo.toml

# 产物：cli/calc-cli/target/x86_64-unknown-linux-musl/release/calc-cli (~460KB)
```

## 上传到服务器

```bash
scp cli/calc-cli/target/x86_64-unknown-linux-musl/release/calc-cli root@c.leot.fun:/opt/leot_svr/tools/bin/
ssh root@c.leot.fun chmod +x /opt/leot_svr/tools/bin/calc-cli
```

## 用法示例

```bash
calc-cli '2 + 3 * 4'           # {"expression":"2 + 3 * 4","result":14}
calc-cli '(1 + 2) ^ 3'         # {"expression":"(1 + 2) ^ 3","result":27}
calc-cli '100 / 3'             # {"expression":"100 / 3","result":33.333...}
calc-cli --expr '10 % 3'       # {"expression":"10 % 3","result":1}
echo '2**10' | calc-cli --stdin # {"expression":"2**10","result":1024}
```

## 验证

```bash
podman exec openclaw-gateway calc-cli '2 + 3 * 4'
# 输出: {"expression":"2 + 3 * 4","result":14}
```
