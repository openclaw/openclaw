#!/usr/bin/env node

/**
 * example.js - Complete node-transfer usage example
 * 
 * This file demonstrates the full workflow for transferring files
 * between OpenClaw nodes using the node-transfer skill.
 */

const INSTALL_DIR = 'C:/openclaw/skills/node-transfer/scripts';

/**
 * Transfer a file between two nodes
 * 
 * @param {string} sourceNode - Source node ID (e.g., 'E3V3')
 * @param {string} destNode - Destination node ID (e.g., 'E3V3-Docker')
 * @param {string} sourcePath - Absolute path to source file
 * @param {string} destPath - Absolute path for destination file
 * @returns {Promise<Object>} Transfer result
 */
async function transferFile(sourceNode, destNode, sourcePath, destPath) {
    console.log(`\n🚀 Starting transfer: ${sourceNode} → ${destNode}`);
    console.log(`   Source: ${sourcePath}`);
    console.log(`   Destination: ${destPath}\n`);

    // Step 1: Check if node-transfer is installed on both nodes
    console.log('⏳ Checking installation status...');
    
    const [sourceCheck, destCheck] = await Promise.all([
        nodes.invoke({
            node: sourceNode,
            command: ['node', `${INSTALL_DIR}/ensure-installed.js`, INSTALL_DIR]
        }),
        nodes.invoke({
            node: destNode,
            command: ['node', `${INSTALL_DIR}/ensure-installed.js`, INSTALL_DIR]
        })
    ]);
    
    const sourceResult = JSON.parse(sourceCheck.output);
    const destResult = JSON.parse(destCheck.output);
    
    console.log(`   Source (${sourceNode}): ${sourceResult.installed ? '✅' : '❌'} ${sourceResult.message}`);
    console.log(`   Destination (${destNode}): ${destResult.installed ? '✅' : '❌'} ${destResult.message}`);
    
    // Step 2: Deploy if needed (one-time per node)
    if (!sourceResult.installed) {
        console.log(`\n📦 Deploying to ${sourceNode}...`);
        // In real usage, use deploy.js to generate and execute deployment
        throw new Error(`Node ${sourceNode} not initialized. Run: node deploy.js ${sourceNode}`);
    }
    
    if (!destResult.installed) {
        console.log(`\n📦 Deploying to ${destNode}...`);
        throw new Error(`Node ${destNode} not initialized. Run: node deploy.js ${destNode}`);
    }
    
    // Step 3: Start sender on source node
    console.log('\n📤 Starting sender...');
    const sendResult = await nodes.invoke({
        node: sourceNode,
        command: ['node', `${INSTALL_DIR}/send.js`, sourcePath]
    });
    
    const senderInfo = JSON.parse(sendResult.output);
    console.log(`   URL: ${senderInfo.url}`);
    console.log(`   File: ${senderInfo.fileName} (${(senderInfo.fileSize / 1024 / 1024).toFixed(2)} MB)`);
    
    // Step 4: Start receiver on destination node
    console.log('\n📥 Starting receiver...');
    const receiveResult = await nodes.invoke({
        node: destNode,
        command: ['node', `${INSTALL_DIR}/receive.js`, 
                  senderInfo.url, senderInfo.token, destPath]
    });
    
    const result = JSON.parse(receiveResult.output);
    
    // Step 5: Report results
    console.log('\n✅ Transfer complete!');
    console.log(`   Received: ${(result.bytesReceived / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Duration: ${result.duration.toFixed(2)} seconds`);
    console.log(`   Speed: ${result.speedMBps} MB/s`);
    console.log(`   Saved to: ${result.outputPath}\n`);
    
    return result;
}

// Example usage (when running via OpenClaw)
async function main() {
    try {
        // Example: Transfer a file from E3V3 to E3V3-Docker
        await transferFile(
            'E3V3',
            'E3V3-Docker',
            'C:/data/large-file.zip',
            '/incoming/large-file.zip'
        );
    } catch (err) {
        console.error('\n❌ Transfer failed:', err.message);
        process.exit(1);
    }
}

// Export for use as module
module.exports = { transferFile };

// Run if called directly
if (require.main === module) {
    main();
}
