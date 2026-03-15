#!/usr/bin/env node

const ecs = require('./api/ecs');

// 格式化输出
function formatTable(data, columns) {
    if (!data || data.length === 0) {
        return '暂无数据';
    }
    
    // 获取每列最大宽度
    const widths = {};
    columns.forEach(col => {
        const headerLength = col.header.length;
        const maxDataLength = Math.max(...data.map(row => String(row[col.key] || '-').length));
        widths[col.key] = Math.max(headerLength, maxDataLength) + 2;
    });
    
    // 生成表头
    let output = '|';
    columns.forEach(col => {
        output += ` ${col.header.padEnd(widths[col.key] - 1)}|`;
    });
    output += '\n';
    
    // 生成分隔线
    output += '|';
    columns.forEach(col => {
        output += '-'.repeat(widths[col.key]) + '|';
    });
    output += '\n';
    
    // 生成数据行
    data.forEach(row => {
        output += '|';
        columns.forEach(col => {
            const cellValue = row[col.key];
            const value = String(cellValue !== undefined && cellValue !== null ? cellValue : '-');
            output += ` ${value.padEnd(widths[col.key] - 1)}|`;
        });
        output += '\n';
    });
    
    return output;
}

// 状态颜色映射
function formatStatus(status) {
    const colors = {
        'Running': '\x1b[32m运行中\x1b[0m',
        'Stopped': '\x1b[31m已停止\x1b[0m',
        'Starting': '\x1b[33m启动中\x1b[0m',
        'Stopping': '\x1b[33m停止中\x1b[0m',
    };
    return colors[status] || status;
}

// 显示帮助
function showHelp() {
    console.log(`
阿里云ECS管理工具

用法:
  aliyun-ecs <command> [options]

命令:
  regions                          查询所有可用地域
  list --region <region>           查询实例列表
  info --region <region> --id <id> 查询实例详情
  start --region <region> --id <id>  启动实例
  stop --region <region> --id <id>   停止实例
  restart --region <region> --id <id> 重启实例
  monitor --region <region> --id <id> [--metrics <metrics>] [--period <seconds>] [--minutes <n>] 查询监控数据
  snapshot list --region <region> --id <id> 查询快照列表
  snapshot create --region <region> --disk-id <id> --name <name> 创建快照
  snapshot rollback --region <region> --disk-id <id> --snapshot-id <id> 回滚快照
  security-group list --region <region> 查询安全组
  security-group rules --region <region> --group-id <id> 查询安全组规则
  security-group add --region <region> --group-id <id> --port <port> 添加安全组规则
  security-group remove --region <region> --group-id <id> --port <port> 删除安全组规则

示例:
  aliyun-ecs regions
  aliyun-ecs list --region cn-hangzhou
  aliyun-ecs info --region cn-hangzhou --id i-bp67acfmxazb4p****
  aliyun-ecs monitor --region cn-hangzhou --id i-bp67acfmxazb4p**** --metrics CPU,Memory
  aliyun-ecs monitor --region cn-hangzhou --id i-xxx --metrics CPU,Memory,InternetIn,InternetOut --period 60 --minutes 30
    `);
}

// 主函数
async function main() {
    const args = process.argv.slice(2);
    
    if (args.length === 0) {
        showHelp();
        process.exit(0);
    }
    
    const command = args[0];
    
    // 解析选项
    const options = {};
    for (let i = 1; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const key = arg.replace(/^--/, '');
            // 检查下一个参数是否存在且不是选项
            const nextArg = args[i + 1];
            if (nextArg !== undefined && !nextArg.startsWith('--')) {
                options[key] = nextArg;
                i++; // 跳过已处理的值
            } else {
                options[key] = true;
            }
        } else if (command === 'snapshot' || command === 'security-group') {
            // 子命令处理
            continue;
        }
    }
    
    try {
        switch (command) {
            case 'regions': {
                const regions = await ecs.describeRegions();
                console.log('\n可用地域列表:\n');
                console.log(formatTable(regions, [
                    { key: 'regionId', header: '地域ID' },
                    { key: 'localName', header: '名称' },
                    { key: 'regionEndpoint', header: 'Endpoint' },
                ]));
                break;
            }
            
            case 'list': {
                if (!options.region) {
                    console.error('错误: 请提供 --region 参数');
                    process.exit(1);
                }
                const pageSize = parseInt(options['page-size']) || 20;
                const pageNumber = parseInt(options.page) || 1;
                const listOptions = {
                    pageSize: pageSize,
                    pageNumber: pageNumber,
                };
                const instances = await ecs.describeInstances(options.region, listOptions);
                console.log(`\n地域 ${options.region} 的实例列表 (第${pageNumber}页, 每页${pageSize}条):\n`);
                if (instances.length === 0) {
                    if (pageNumber > 1) {
                        console.log('该页无实例，可能是已到达末尾');
                    } else {
                        console.log('暂无实例');
                    }
                } else {
                    console.log(formatTable(instances.map(inst => ({
                        ...inst,
                        status: formatStatus(inst.status),
                        ip: inst.publicIpAddress.join(', ') || inst.privateIpAddress.join(', '),
                    })), [
                        { key: 'instanceId', header: '实例ID' },
                        { key: 'instanceName', header: '名称' },
                        { key: 'status', header: '状态' },
                        { key: 'instanceType', header: '类型' },
                        { key: 'ip', header: 'IP地址' },
                    ]));
                    console.log(`\n提示: 使用 --page N 查看下一页，--page-size N 调整每页数量`);
                }
                break;
            }
            
            case 'info': {
                if (!options.region || !options.id) {
                    console.error('错误: 请提供 --region 和 --id 参数');
                    process.exit(1);
                }
                const instances = await ecs.describeInstances(options.region, {
                    instanceIds: JSON.stringify([options.id]),
                });
                if (instances.length === 0) {
                    console.log('实例不存在');
                    process.exit(1);
                }
                const inst = instances[0];
                console.log('\n实例详情:\n');
                console.log(`  实例ID: ${inst.instanceId}`);
                console.log(`  名称: ${inst.instanceName}`);
                console.log(`  状态: ${formatStatus(inst.status)}`);
                console.log(`  地域: ${inst.regionId}`);
                console.log(`  可用区: ${inst.zoneId}`);
                console.log(`  实例类型: ${inst.instanceType}`);
                console.log(`  CPU: ${inst.cpu}核`);
                console.log(`  内存: ${inst.memory}MB`);
                console.log(`  操作系统: ${inst.osName}`);
                console.log(`  公网IP: ${inst.publicIpAddress.join(', ') || '无'}`);
                console.log(`  私网IP: ${inst.privateIpAddress.join(', ') || '无'}`);
                console.log(`  创建时间: ${inst.creationTime}`);
                console.log(`  到期时间: ${inst.expiredTime || '按量付费'}`);
                break;
            }
            
            case 'start': {
                if (!options.region || !options.id) {
                    console.error('错误: 请提供 --region 和 --id 参数');
                    process.exit(1);
                }
                console.log(`正在启动实例 ${options.id}...`);
                const result = await ecs.startInstance(options.region, options.id);
                console.log(`✓ 启动成功 (RequestId: ${result.requestId})`);
                break;
            }
            
            case 'stop': {
                if (!options.region || !options.id) {
                    console.error('错误: 请提供 --region 和 --id 参数');
                    process.exit(1);
                }
                console.log(`正在停止实例 ${options.id}...`);
                const result = await ecs.stopInstance(options.region, options.id, options.force);
                console.log(`✓ 停止成功 (RequestId: ${result.requestId})`);
                break;
            }
            
            case 'restart': {
                if (!options.region || !options.id) {
                    console.error('错误: 请提供 --region 和 --id 参数');
                    process.exit(1);
                }
                console.log(`正在重启实例 ${options.id}...`);
                const result = await ecs.rebootInstance(options.region, options.id, options.force);
                console.log(`✓ 重启成功 (RequestId: ${result.requestId})`);
                break;
            }
            
            case 'monitor': {
                if (!options.region || !options.id) {
                    console.error('错误: 请提供 --region 和 --id 参数');
                    process.exit(1);
                }
                
                // 解析指标列表，默认为CPU和内存
                const metrics = options.metrics ? options.metrics.split(',') : ['CPU', 'Memory'];
                const period = parseInt(options.period) || 300; // 默认5分钟粒度
                const minutes = parseInt(options.minutes) || 60; // 默认查询最近60分钟
                
                // 计算时间范围
                const endTime = new Date();
                const startTime = new Date(endTime.getTime() - minutes * 60 * 1000);
                
                console.log(`\n正在查询实例 ${options.id} 的监控数据...`);
                console.log(`指标: ${metrics.join(', ')}`);
                console.log(`时间范围: ${startTime.toISOString()} ~ ${endTime.toISOString()}`);
                console.log('');
                
                const monitorData = await ecs.describeInstanceMonitorData(
                    options.region,
                    options.id,
                    period,
                    startTime.toISOString(),
                    endTime.toISOString()
                );
                
                if (monitorData.length === 0) {
                    console.log('暂无监控数据（实例可能已停止或刚启动）');
                } else {
                    // 格式化显示监控数据
                    const columns = [{ key: 'timestamp', header: '时间' }];
                    if (metrics.includes('CPU')) columns.push({ key: 'cpu', header: 'CPU(%)' });
                    if (metrics.includes('Memory')) columns.push({ key: 'memory', header: '内存(%)' });
                    if (metrics.includes('InternetIn')) columns.push({ key: 'internetIn', header: '公网入(Kbps)' });
                    if (metrics.includes('InternetOut')) columns.push({ key: 'internetOut', header: '公网出(Kbps)' });
                    if (metrics.includes('IntranetIn')) columns.push({ key: 'intranetIn', header: '内网入(Kbps)' });
                    if (metrics.includes('IntranetOut')) columns.push({ key: 'intranetOut', header: '内网出(Kbps)' });
                    
                    // 格式化时间戳和数据
                    const formattedData = monitorData.map(d => ({
                        timestamp: new Date(d.timestamp).toLocaleString('zh-CN'),
                        cpu: d.cpu !== undefined ? d.cpu.toFixed(2) : '-',
                        memory: d.memory !== undefined ? d.memory.toFixed(2) : '-',
                        internetIn: d.internetIn !== undefined ? d.internetIn.toFixed(2) : '-',
                        internetOut: d.internetOut !== undefined ? d.internetOut.toFixed(2) : '-',
                        intranetIn: d.intranetIn !== undefined ? d.intranetIn.toFixed(2) : '-',
                        intranetOut: d.intranetOut !== undefined ? d.intranetOut.toFixed(2) : '-',
                    }));
                    
                    console.log(formatTable(formattedData, columns));
                    console.log(`\n共 ${monitorData.length} 个数据点`);
                }
                break;
            }
            
            case 'snapshot': {
                const subCommand = args[1];
                if (subCommand === 'list') {
                    if (!options.region || !options.id) {
                        console.error('错误: 请提供 --region 和 --id 参数');
                        process.exit(1);
                    }
                    // 查询实例的快照列表
                    const snapshots = await ecs.describeSnapshots(options.region, options.id, null);
                    console.log(`\n实例 ${options.id} 的快照列表:\n`);
                    if (snapshots.length === 0) {
                        console.log('暂无快照');
                    } else {
                        console.log(formatTable(snapshots.map(snap => ({
                            ...snap,
                            status: snap.status === 'accomplished' ? '已完成' : snap.status,
                        })), [
                            { key: 'snapshotId', header: '快照ID' },
                            { key: 'snapshotName', header: '名称' },
                            { key: 'status', header: '状态' },
                            { key: 'progress', header: '进度' },
                            { key: 'creationTime', header: '创建时间' },
                        ]));
                    }
                } else if (subCommand === 'create') {
                    if (!options.region || !options['disk-id'] || !options.name) {
                        console.error('错误: 请提供 --region, --disk-id 和 --name 参数');
                        process.exit(1);
                    }
                    console.log(`正在创建快照 ${options.name}...`);
                    const result = await ecs.createSnapshot(options.region, options['disk-id'], options.name, options.description || '');
                    console.log(`✓ 快照创建成功 (SnapshotId: ${result.snapshotId})`);
                } else if (subCommand === 'rollback') {
                    if (!options.region || !options['disk-id'] || !options['snapshot-id']) {
                        console.error('错误: 请提供 --region, --disk-id 和 --snapshot-id 参数');
                        process.exit(1);
                    }
                    console.log(`正在回滚快照 ${options['snapshot-id']}...`);
                    const result = await ecs.resetDisk(options.region, options['disk-id'], options['snapshot-id']);
                    console.log(`✓ 回滚成功 (RequestId: ${result.requestId})`);
                } else {
                    console.error('未知的 snapshot 子命令');
                    process.exit(1);
                }
                break;
            }
            
            case 'security-group': {
                const subCommand = args[1];
                if (subCommand === 'list') {
                    if (!options.region) {
                        console.error('错误: 请提供 --region 参数');
                        process.exit(1);
                    }
                    const groups = await ecs.describeSecurityGroups(options.region);
                    console.log(`\n地域 ${options.region} 的安全组列表:\n`);
                    if (groups.length === 0) {
                        console.log('暂无安全组');
                    } else {
                        console.log(formatTable(groups, [
                            { key: 'securityGroupId', header: '安全组ID' },
                            { key: 'securityGroupName', header: '名称' },
                            { key: 'description', header: '描述' },
                        ]));
                    }
                } else if (subCommand === 'rules') {
                    if (!options.region || !options['group-id']) {
                        console.error('错误: 请提供 --region 和 --group-id 参数');
                        process.exit(1);
                    }
                    const rules = await ecs.describeSecurityGroupAttribute(options.region, options['group-id']);
                    console.log(`\n安全组 ${options['group-id']} 的入方向规则:\n`);
                    if (rules.length === 0) {
                        console.log('暂无规则');
                    } else {
                        console.log(formatTable(rules.map(rule => ({
                            ...rule,
                            policy: rule.policy === 'accept' ? '允许' : '拒绝',
                        })), [
                            { key: 'ipProtocol', header: '协议' },
                            { key: 'portRange', header: '端口' },
                            { key: 'sourceCidrIp', header: '源IP' },
                            { key: 'policy', header: '策略' },
                            { key: 'description', header: '描述' },
                        ]));
                    }
                } else if (subCommand === 'add') {
                    if (!options.region || !options['group-id'] || !options.port) {
                        console.error('错误: 请提供 --region, --group-id 和 --port 参数');
                        process.exit(1);
                    }
                    console.log(`正在添加安全组规则 (端口: ${options.port})...`);
                    const result = await ecs.authorizeSecurityGroup(
                        options.region,
                        options['group-id'],
                        options.protocol || 'tcp',
                        options.port,
                        options.cidr || '0.0.0.0/0',
                        options.description || ''
                    );
                    console.log(`✓ 规则添加成功 (RequestId: ${result.requestId})`);
                } else if (subCommand === 'remove') {
                    if (!options.region || !options['group-id'] || !options.port) {
                        console.error('错误: 请提供 --region, --group-id 和 --port 参数');
                        process.exit(1);
                    }
                    console.log(`正在删除安全组规则 (端口: ${options.port})...`);
                    const result = await ecs.revokeSecurityGroup(
                        options.region,
                        options['group-id'],
                        options.protocol || 'tcp',
                        options.port,
                        options.cidr || '0.0.0.0/0'
                    );
                    console.log(`✓ 规则删除成功 (RequestId: ${result.requestId})`);
                } else {
                    console.error('未知的安全组子命令');
                    process.exit(1);
                }
                break;
            }
            
            default: {
                console.error(`未知命令: ${command}`);
                showHelp();
                process.exit(1);
            }
        }
    } catch (error) {
        console.error(`\n错误: ${error.message}`);
        if (error.message.includes('配置文件')) {
            console.error('\n请先运行设置脚本:');
            console.error('  ./scripts/setup.sh --access-key-id YOUR_ID --access-key-secret YOUR_SECRET');
        }
        process.exit(1);
    }
}

main();
