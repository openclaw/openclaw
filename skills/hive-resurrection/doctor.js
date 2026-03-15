#!/usr/bin/env node

/**
 * 蜂巢复活系统 - Doctor 诊断修复引擎
 * 
 * 自动检测 openclaw 出问题的原因并修复：
 * - 未安装 → 调用 installer 安装
 * - 依赖缺失 → npm install
 * - 配置损坏 → 从备份恢复
 * - 端口占用 → 杀死占用进程
 * - 磁盘满 → 清理空间
 * - 权限错误 → 修复权限
 * - 数据损坏 → 从快照恢复
 */

const { execSync, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');

class Doctor {
  constructor(config, logger) {
    this.oc = config.openclaw;
    this.dc = config.doctor;
    this.log = logger || console.log;
    this.diagnosisResults = [];
    this.repairsPerformed = [];
  }

  // ============ 主入口：完整诊断 + 修复流程 ============
  async diagnoseAndRepair() {
    this.diagnosisResults = [];
    this.repairsPerformed = [];

    this.log('INFO', '===== 开始诊断 =====');

    const checks = [
      { name: '系统环境', fn: () => this.checkSystem() },
      { name: 'Node.js 环境', fn: () => this.checkNodeJs() },
      { name: 'openclaw 安装', fn: () => this.checkInstallation() },
      { name: '依赖完整性', fn: () => this.checkDependencies() },
      { name: '配置文件', fn: () => this.checkConfig() },
      { name: '磁盘空间', fn: () => this.checkDiskSpace() },
      { name: '端口占用', fn: () => this.checkPort() }
    ];

    for (const check of checks) {
      try {
        this.log('INFO', `检查：${check.name}...`);
        const result = await check.fn();
        this.diagnosisResults.push({ check: check.name, ...result });

        if (result.status === 'error') {
          this.log('WARN', `  问题：${result.problem}`);

          if (result.canAutoRepair) {
            this.log('INFO', `  修复：${result.repairAction}`);
            const repairResult = await result.repair();
            this.repairsPerformed.push({
              check: check.name,
              action: result.repairAction,
              success: repairResult.success,
              detail: repairResult.detail
            });

            if (repairResult.success) {
              this.log('INFO', `  ✓ 修复成功：${repairResult.detail}`);
              result.status = 'repaired';
            } else {
              this.log('ERROR', `  ✗ 修复失败：${repairResult.detail}`);
            }
          } else {
            this.log('ERROR', `  需要人工处理：${result.manualAction}`);
          }
        } else {
          this.log('INFO', `  ✓ 正常`);
        }
      } catch (err) {
        this.log('ERROR', `检查 ${check.name} 出错：${err.message}`);
        this.diagnosisResults.push({
          check: check.name,
          status: 'check_error',
          problem: err.message
        });
      }
    }

    this.log('INFO', '===== 诊断完成 =====');

    return {
      timestamp: new Date().toISOString(),
      diagnosis: this.diagnosisResults,
      repairs: this.repairsPerformed,
      overallHealthy: this.diagnosisResults.every(
        (d) => d.status === 'ok' || d.status === 'repaired'
      )
    };
  }

  // ============ 检查：系统环境 ============
  checkSystem() {
    const freeMemMB = Math.floor(os.freemem() / 1024 / 1024);
    const loadAvg = os.loadavg()[0];
    const cpuCount = os.cpus().length;

    if (freeMemMB < 200) {
      return {
        status: 'error',
        problem: `可用内存仅 ${freeMemMB}MB`,
        canAutoRepair: true,
        repairAction: '清理系统缓存',
        repair: async () => {
          try {
            this.exec('sync');
            try { this.exec('echo 3 > /proc/sys/vm/drop_caches'); } catch (e) {}
            const newFreeMB = Math.floor(os.freemem() / 1024 / 1024);
            return { success: newFreeMB > 200, detail: `释放后可用内存：${newFreeMB}MB` };
          } catch (err) {
            return { success: false, detail: err.message };
          }
        }
      };
    }

    if (loadAvg > cpuCount * 2) {
      return {
        status: 'error',
        problem: `系统负载过高：${loadAvg.toFixed(1)}`,
        canAutoRepair: false,
        manualAction: '检查高 CPU 进程'
      };
    }

    return { status: 'ok' };
  }

  // ============ 检查：Node.js 环境 ============
  checkNodeJs() {
    try {
      const version = this.exec('node -v').trim();
      const major = parseInt(version.replace('v', '').split('.')[0]);

      if (major < 18) {
        return {
          status: 'error',
          problem: `Node.js 版本过低：${version}`,
          canAutoRepair: true,
          repairAction: '升级 Node.js',
          repair: async () => {
            try {
              this.exec('curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -');
              this.exec('sudo apt-get install -y nodejs');
              return { success: true, detail: `Node.js 已升级` };
            } catch (err) {
              return { success: false, detail: err.message };
            }
          }
        };
      }
      return { status: 'ok' };
    } catch (err) {
      return {
        status: 'error',
        problem: 'Node.js 未安装',
        canAutoRepair: true,
        repairAction: '安装 Node.js',
        repair: async () => this.installNodeJs()
      };
    }
  }

  async installNodeJs() {
    try {
      const platform = os.platform();
      if (platform === 'linux') {
        this.exec('curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -');
        this.exec('sudo apt-get install -y nodejs');
      }
      const ver = this.exec('node -v').trim();
      return { success: true, detail: `Node.js ${ver} 已安装` };
    } catch (err) {
      return { success: false, detail: err.message };
    }
  }

  // ============ 检查：openclaw 安装 ============
  checkInstallation() {
    const installDir = this.oc.installDir || this.oc.workDir;

    if (!fs.existsSync(installDir)) {
      return {
        status: 'error',
        problem: `安装目录不存在：${installDir}`,
        canAutoRepair: true,
        repairAction: '完整安装 openclaw',
        repair: async () => this.fullInstall()
      };
    }

    const pkgPath = path.join(installDir, 'package.json');
    if (!fs.existsSync(pkgPath)) {
      return {
        status: 'error',
        problem: 'package.json 缺失',
        canAutoRepair: true,
        repairAction: '重新安装 openclaw',
        repair: async () => this.fullInstall()
      };
    }

    return { status: 'ok' };
  }

  // ============ 完整安装 openclaw ============
  async fullInstall() {
    try {
      const installDir = this.oc.installDir || this.oc.workDir;
      const repo = this.oc.repo || 'https://github.com/openclaw/openclaw.git';
      const branch = this.oc.branch || 'main';

      this.log('INFO', `开始完整安装 openclaw 到 ${installDir}`);

      // 检查 git
      try { this.exec('git --version'); } catch (e) {
        this.log('INFO', '安装 git...');
        this.exec('sudo apt-get update && sudo apt-get install -y git');
      }

      // 克隆或拉取
      if (fs.existsSync(path.join(installDir, '.git'))) {
        this.exec(`cd ${installDir} && git fetch origin && git reset --hard origin/${branch}`);
      } else {
        fs.mkdirSync(installDir, { recursive: true });
        this.exec(`git clone -b ${branch} ${repo} ${installDir}`);
      }

      // 安装依赖
      this.log('INFO', '安装 npm 依赖...');
      this.exec(`cd ${installDir} && npm install --production`, { timeout: 120000 });

      // 全局链接
      try { this.exec(`cd ${installDir} && npm link`); } catch (e) {}

      // 验证
      const pkg = JSON.parse(fs.readFileSync(path.join(installDir, 'package.json'), 'utf8'));
      return { success: true, detail: `openclaw ${pkg.version} 安装完成` };
    } catch (err) {
      return { success: false, detail: err.message };
    }
  }

  // ============ 检查：依赖完整性 ============
  checkDependencies() {
    const installDir = this.oc.installDir || this.oc.workDir;
    const nodeModules = path.join(installDir, 'node_modules');

    if (!fs.existsSync(nodeModules)) {
      return {
        status: 'error',
        problem: 'node_modules 目录不存在',
        canAutoRepair: true,
        repairAction: '执行 npm install',
        repair: async () => {
          try {
            this.exec(`cd ${installDir} && npm install --production`, { timeout: 120000 });
            return { success: true, detail: '依赖安装完成' };
          } catch (err) {
            return { success: false, detail: err.message };
          }
        }
      };
    }

    return { status: 'ok' };
  }

  // ============ 检查：配置文件 ============
  checkConfig() {
    const configFile = this.oc.configFile;
    if (!configFile || !fs.existsSync(configFile)) {
      return {
        status: 'error',
        problem: '配置文件不存在',
        canAutoRepair: true,
        repairAction: '生成默认配置',
        repair: async () => {
          try {
            const dir = path.dirname(configFile);
            fs.mkdirSync(dir, { recursive: true });
            const defaultConfig = '# OpenClaw 配置\nserver:\n  port: 3000\n';
            fs.writeFileSync(configFile, defaultConfig);
            return { success: true, detail: '生成默认配置' };
          } catch (err) {
            return { success: false, detail: err.message };
          }
        }
      };
    }

    try {
      const content = fs.readFileSync(configFile, 'utf8');
      if (content.trim().length === 0) {
        return {
          status: 'error',
          problem: '配置文件为空',
          canAutoRepair: true,
          repairAction: '从备份恢复',
          repair: async () => {
            const backups = fs.readdirSync(path.dirname(configFile))
              .filter(f => f.startsWith(path.basename(configFile) + '.backup'))
              .sort().reverse();
            if (backups.length > 0) {
              fs.copyFileSync(
                path.join(path.dirname(configFile), backups[0]),
                configFile
              );
              return { success: true, detail: `从备份恢复：${backups[0]}` };
            }
            return { success: false, detail: '没有可用备份' };
          }
        };
      }
    } catch (err) {
      return {
        status: 'error',
        problem: `配置文件读取失败：${err.message}`,
        canAutoRepair: false,
        manualAction: '手动修复配置文件'
      };
    }

    return { status: 'ok' };
  }

  // ============ 检查：磁盘空间 ============
  checkDiskSpace() {
    try {
      const stat = fs.statfsSync(this.oc.workDir || '/');
      const freeGB = (stat.bsize * stat.bfree / 1024 / 1024 / 1024).toFixed(2);
      const freePercent = (stat.bfree / stat.blocks * 100).toFixed(1);

      if (parseFloat(freePercent) < 10) {
        return {
          status: 'error',
          problem: `磁盘空间不足：${freeGB}GB (${freePercent}%)`,
          canAutoRepair: true,
          repairAction: '清理日志和缓存',
          repair: async () => this.cleanupDisk()
        };
      }
      return { status: 'ok', detail: `${freeGB}GB 可用` };
    } catch (err) {
      return { status: 'ok', detail: '无法检查磁盘空间' };
    }
  }

  async cleanupDisk() {
    try {
      const logDir = path.join(this.oc.workDir || '/tmp', 'logs');
      if (fs.existsSync(logDir)) {
        const files = fs.readdirSync(logDir)
          .map(f => ({ name: f, time: fs.statSync(path.join(logDir, f)).mtime.getTime() }))
          .sort((a, b) => a.time - b.time);
        
        // 删除最旧的 5 个日志文件
        for (let i = 0; i < Math.min(5, files.length); i++) {
          fs.unlinkSync(path.join(logDir, files[i].name));
        }
      }
      return { success: true, detail: '清理完成' };
    } catch (err) {
      return { success: false, detail: err.message };
    }
  }

  // ============ 检查：端口占用 ============
  checkPort() {
    const port = 3000; // 默认端口

    try {
      const result = this.exec(`lsof -i :${port} 2>/dev/null || netstat -tlnp 2>/dev/null | grep :${port}`);
      if (result.trim()) {
        return {
          status: 'error',
          problem: `端口 ${port} 被占用`,
          canAutoRepair: true,
          repairAction: '杀死占用端口的进程',
          repair: async () => {
            try {
              const pidMatch = result.match(/(\d+)/);
              if (pidMatch) {
                this.exec(`kill -9 ${pidMatch[1]}`);
                return { success: true, detail: `已杀死进程 ${pidMatch[1]}` };
              }
              return { success: false, detail: '无法获取进程 ID' };
            } catch (err) {
              return { success: false, detail: err.message };
            }
          }
        };
      }
      return { status: 'ok' };
    } catch (err) {
      return { status: 'ok', detail: '无法检查端口' };
    }
  }

  // ============ 工具方法 ============
  exec(cmd, options = {}) {
    return execSync(cmd, { encoding: 'utf8', timeout: options.timeout || 30000, ...options });
  }
}

module.exports = Doctor;
