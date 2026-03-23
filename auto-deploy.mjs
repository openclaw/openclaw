#!/usr/bin/env node

// 自动部署脚本 (Node.js 版本)

import { execSync, exec } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const WORK_DIR = __dirname;

console.log('=== 自动部署脚本 ===\n');

// 检查pm2是否安装
function checkPM2() {
    try {
        execSync('pm2 --version', { stdio: 'ignore' });
        return true;
    } catch (error) {
        return false;
    }
}

// 安装pm2
function installPM2() {
    console.log('pm2未安装，正在安装...');
    try {
        execSync('npm install -g pm2', { stdio: 'inherit' });
        console.log('pm2安装成功！');
        return true;
    } catch (error) {
        console.error('pm2安装失败:', error.message);
        return false;
    }
}

// 停止现有的服务
function stopExistingServices() {
    console.log('正在停止现有服务...');
    try {
        execSync('pm2 stop all', { stdio: 'inherit' });
        console.log('现有服务已停止');
    } catch (error) {
        console.warn('停止服务时出错:', error.message);
    }
}

// 启动网关服务
function startGateway() {
    console.log('正在启动网关服务...');
    try {
        execSync('pm2 start openclaw.mjs --name "jsclaw-gateway" -- gateway', { cwd: WORK_DIR, stdio: 'inherit' });
        console.log('网关服务启动成功');
        return true;
    } catch (error) {
        console.error('网关服务启动失败:', error.message);
        return false;
    }
}

// 启动Web UI
function startDashboard() {
    console.log('正在启动Web UI...');
    try {
        execSync('pm2 start openclaw.mjs --name "jsclaw-dashboard" -- dashboard', { cwd: WORK_DIR, stdio: 'inherit' });
        console.log('Web UI启动成功');
        return true;
    } catch (error) {
        console.error('Web UI启动失败:', error.message);
        return false;
    }
}

// 显示服务状态
function showStatus() {
    console.log('\n服务状态：');
    try {
        execSync('pm2 status', { stdio: 'inherit' });
    } catch (error) {
        console.error('显示状态失败:', error.message);
    }
}

// 主函数
async function main() {
    // 检查并安装pm2
    if (!checkPM2()) {
        if (!installPM2()) {
            process.exit(1);
        }
    }
    
    // 停止现有服务
    stopExistingServices();
    
    // 启动网关服务
    if (!startGateway()) {
        process.exit(1);
    }
    
    // 等待网关服务启动
    console.log('等待网关服务启动...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    // 启动Web UI
    if (!startDashboard()) {
        process.exit(1);
    }
    
    // 显示服务状态
    showStatus();
    
    // 显示访问地址
    console.log('\n访问地址：');
    console.log('Web UI: http://localhost:18789');
    console.log('网关: ws://localhost:18789');
    
    console.log('\n部署完成！');
}

// 执行主函数
main().catch(error => {
    console.error('部署过程中出错:', error.message);
    process.exit(1);
});
