const { default: OpenApi, $OpenApi } = require('@alicloud/openapi-client');
const Ecs20140526 = require('@alicloud/ecs20140526');
const fs = require('fs');
const path = require('path');

// 加载配置
function loadConfig() {
    const configPath = path.join(process.env.HOME, '.aliyun', 'config.json');
    if (!fs.existsSync(configPath)) {
        throw new Error('配置文件不存在，请先运行 setup.sh 进行配置');
    }
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
}

// 创建ECS客户端
function createClient(regionId) {
    const config = loadConfig();
    
    const clientConfig = new $OpenApi({
        accessKeyId: config.accessKeyId,
        accessKeySecret: config.accessKeySecret,
    });
    
    clientConfig.endpoint = `ecs.${regionId}.aliyuncs.com`;
    
    return new Ecs20140526(clientConfig);
}

// 查询地域列表
async function describeRegions() {
    const config = loadConfig();
    const clientConfig = new $OpenApi({
        accessKeyId: config.accessKeyId,
        accessKeySecret: config.accessKeySecret,
    });
    clientConfig.endpoint = 'ecs.aliyuncs.com';
    
    const client = new Ecs20140526(clientConfig);
    const response = await client.describeRegions(new Ecs20140526.DescribeRegionsRequest({}));
    
    return response.body.regions.region.map(r => ({
        regionId: r.regionId,
        regionEndpoint: r.regionEndpoint,
        localName: r.localName
    }));
}

// 查询实例列表
async function describeInstances(regionId, options = {}) {
    const client = createClient(regionId);
    
    const request = new Ecs20140526.DescribeInstancesRequest({
        regionId: regionId,
        pageSize: options.pageSize || 20,
        pageNumber: options.pageNumber || 1,
    });
    
    if (options.instanceIds) {
        request.instanceIds = options.instanceIds;
    }
    
    const response = await client.describeInstances(request);
    
    if (!response.body.instances || !response.body.instances.instance) {
        return [];
    }
    
    return response.body.instances.instance.map(inst => ({
        instanceId: inst.instanceId,
        instanceName: inst.instanceName,
        status: inst.status,
        regionId: inst.regionId,
        zoneId: inst.zoneId,
        instanceType: inst.instanceType,
        cpu: inst.cpu,
        memory: inst.memory,
        osName: inst.osName,
        osType: inst.osType,
        publicIpAddress: inst.publicIpAddress?.ipAddress || [],
        privateIpAddress: inst.vpcAttributes?.privateIpAddress?.ipAddress || [],
        creationTime: inst.creationTime,
        expiredTime: inst.expiredTime,
        networkType: inst.networkType,
        internetChargeType: inst.internetChargeType,
    }));
}

// 启动实例
async function startInstance(regionId, instanceId) {
    const client = createClient(regionId);
    
    const request = new Ecs20140526.StartInstanceRequest({
        instanceId: instanceId,
    });
    
    const response = await client.startInstance(request);
    return {
        requestId: response.body.requestId,
        success: true,
    };
}

// 停止实例
async function stopInstance(regionId, instanceId, forceStop = false) {
    const client = createClient(regionId);
    
    const request = new Ecs20140526.StopInstanceRequest({
        instanceId: instanceId,
        forceStop: forceStop,
    });
    
    const response = await client.stopInstance(request);
    return {
        requestId: response.body.requestId,
        success: true,
    };
}

// 重启实例
async function rebootInstance(regionId, instanceId, forceStop = false) {
    const client = createClient(regionId);
    
    const request = new Ecs20140526.RebootInstanceRequest({
        instanceId: instanceId,
        forceStop: forceStop,
    });
    
    const response = await client.rebootInstance(request);
    return {
        requestId: response.body.requestId,
        success: true,
    };
}

// 获取监控数据
async function describeInstanceMonitorData(regionId, instanceId, period = 60, startTime, endTime) {
    const client = createClient(regionId);
    
    const request = new Ecs20140526.DescribeInstanceMonitorDataRequest({
        regionId: regionId,
        instanceId: instanceId,
        period: period,
    });
    
    if (startTime) request.startTime = startTime;
    if (endTime) request.endTime = endTime;
    
    const response = await client.describeInstanceMonitorData(request);
    
    if (!response.body.monitorData || !response.body.monitorData.instanceMonitorData) {
        return [];
    }
    
    return response.body.monitorData.instanceMonitorData.map(data => ({
        timestamp: data.timeStamp,
        cpu: data.CPU,
        memory: data.memory,
        internetIn: data.internetIn,
        internetOut: data.internetOut,
        intranetIn: data.intranetIn,
        intranetOut: data.intranetOut,
    }));
}

// 创建快照
async function createSnapshot(regionId, diskId, snapshotName, description = '') {
    const client = createClient(regionId);
    
    const request = new Ecs20140526.CreateSnapshotRequest({
        diskId: diskId,
        snapshotName: snapshotName,
        description: description,
    });
    
    const response = await client.createSnapshot(request);
    return {
        requestId: response.body.requestId,
        snapshotId: response.body.snapshotId,
        success: true,
    };
}

// 查询快照
async function describeSnapshots(regionId, instanceId, diskId) {
    const client = createClient(regionId);
    
    const request = new Ecs20140526.DescribeSnapshotsRequest({
        regionId: regionId,
    });
    
    if (instanceId) request.instanceId = instanceId;
    if (diskId) request.diskIds = JSON.stringify([diskId]);
    
    const response = await client.describeSnapshots(request);
    
    if (!response.body.snapshots || !response.body.snapshots.snapshot) {
        return [];
    }
    
    return response.body.snapshots.snapshot.map(snap => ({
        snapshotId: snap.snapshotId,
        snapshotName: snap.snapshotName,
        description: snap.description,
        status: snap.status,
        progress: snap.progress,
        creationTime: snap.creationTime,
        sourceDiskId: snap.sourceDiskId,
        sourceDiskType: snap.sourceDiskType,
    }));
}

// 回滚快照
async function resetDisk(regionId, diskId, snapshotId) {
    const client = createClient(regionId);
    
    const request = new Ecs20140526.ResetDiskRequest({
        diskId: diskId,
        snapshotId: snapshotId,
    });
    
    const response = await client.resetDisk(request);
    return {
        requestId: response.body.requestId,
        success: true,
    };
}

// 查询安全组
async function describeSecurityGroups(regionId, options = {}) {
    const client = createClient(regionId);
    
    const request = new Ecs20140526.DescribeSecurityGroupsRequest({
        regionId: regionId,
    });
    
    if (options.securityGroupId) {
        request.securityGroupIds = options.securityGroupId;
    }
    
    const response = await client.describeSecurityGroups(request);
    
    if (!response.body.securityGroups || !response.body.securityGroups.securityGroup) {
        return [];
    }
    
    return response.body.securityGroups.securityGroup.map(sg => ({
        securityGroupId: sg.securityGroupId,
        securityGroupName: sg.securityGroupName,
        description: sg.description,
        vpcId: sg.vpcId,
        creationTime: sg.creationTime,
    }));
}

// 查询安全组规则
async function describeSecurityGroupAttribute(regionId, securityGroupId, direction = 'ingress') {
    const client = createClient(regionId);
    
    const request = new Ecs20140526.DescribeSecurityGroupAttributeRequest({
        regionId: regionId,
        securityGroupId: securityGroupId,
        direction: direction,
    });
    
    const response = await client.describeSecurityGroupAttribute(request);
    
    const rules = response.body.permissions?.permission;
    
    if (!rules) return [];
    
    return rules.map(rule => ({
        ipProtocol: rule.ipProtocol,
        portRange: rule.portRange,
        sourceCidrIp: rule.sourceCidrIp,
        destCidrIp: rule.destCidrIp,
        policy: rule.policy,
        description: rule.description,
    }));
}

// 授权安全组规则
async function authorizeSecurityGroup(regionId, securityGroupId, ipProtocol, portRange, sourceCidrIp = '0.0.0.0/0', description = '') {
    const client = createClient(regionId);
    
    const request = new Ecs20140526.AuthorizeSecurityGroupRequest({
        regionId: regionId,
        securityGroupId: securityGroupId,
        ipProtocol: ipProtocol,
        portRange: portRange,
        sourceCidrIp: sourceCidrIp,
        description: description,
        policy: 'accept',
    });
    
    const response = await client.authorizeSecurityGroup(request);
    return {
        requestId: response.body.requestId,
        success: true,
    };
}

// 撤销安全组规则
async function revokeSecurityGroup(regionId, securityGroupId, ipProtocol, portRange, sourceCidrIp = '0.0.0.0/0') {
    const client = createClient(regionId);
    
    const request = new Ecs20140526.RevokeSecurityGroupRequest({
        regionId: regionId,
        securityGroupId: securityGroupId,
        ipProtocol: ipProtocol,
        portRange: portRange,
        sourceCidrIp: sourceCidrIp,
    });
    
    const response = await client.revokeSecurityGroup(request);
    return {
        requestId: response.body.requestId,
        success: true,
    };
}

module.exports = {
    describeRegions,
    describeInstances,
    startInstance,
    stopInstance,
    rebootInstance,
    describeInstanceMonitorData,
    createSnapshot,
    describeSnapshots,
    resetDisk,
    describeSecurityGroups,
    describeSecurityGroupAttribute,
    authorizeSecurityGroup,
    revokeSecurityGroup,
};
