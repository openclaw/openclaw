import hardhat from "hardhat";
const CLAW_TOKEN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function transfer(address to, uint256 amount) returns (bool)",
  "function transferFrom(address from, address to, uint256 amount) returns (bool)",
  "function createEscrow(address seller, uint256 amount, bytes32 tradeId)",
  "function releaseEscrow(bytes32 tradeId)",
  "function refundEscrow(bytes32 tradeId)",
  "function escrows(bytes32 tradeId) view returns (address buyer, address seller, uint256 amount, uint256 createdAt, uint256 expiresAt, uint8 state)",
  "function escrowTimeout() view returns (uint256)",
  "function mint(address to, uint256 amount)",
  "function setEscrowTimeout(uint256 newTimeout)",
  "function owner() view returns (address)",
  "event EscrowCreated(bytes32 indexed tradeId, address indexed buyer, address indexed seller, uint256 amount, uint256 expiresAt)",
  "event EscrowReleased(bytes32 indexed tradeId, address indexed seller, uint256 amount)",
  "event EscrowRefunded(bytes32 indexed tradeId, address indexed buyer, uint256 amount)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
] as const;
import { readFileSync } from "fs";
import { join } from "path";

async function main() {
  const { ethers } = hardhat as any;
  console.log("=== 🤖 INICIANDO SIMULACIÓN DE AGENT COMMERCE ===\n");

  // 1. Cargar la dirección del contrato desde moltbot.json
  const moltbotConfigPath = join(
    process.env.HOME || process.env.USERPROFILE || "",
    ".clawdbot",
    "moltbot.json",
  );
  const config = JSON.parse(readFileSync(moltbotConfigPath, "utf-8"));
  const contractAddress = config.plugins.entries["agent-commerce"].contractAddress;
  console.log(`📍 Contrato ClawToken conectado en: ${contractAddress}`);

  // 2. Obtener cuentas de prueba locales
  const signers = await ethers.getSigners();
  const owner = signers[0]; // El que desplegó el contrato (tiene el millón de CLAW)
  const buyerAgent = signers[1];
  const sellerAgent = signers[2];

  const contract = new ethers.Contract(contractAddress, CLAW_TOKEN_ABI, owner);

  // 3. Preparación Inicial: El Owner le da algo de saldo al Comprador (Buyer)
  console.log("\n💸 [FASE 1] Repartiendo tokens iniciales a los Agentes...");
  const transferAmount = ethers.parseUnits("500", 18); // 500 CLAW
  await contract.connect(owner).transfer(buyerAgent.address, transferAmount);
  console.log(
    `✅ El Agente Comprador (${buyerAgent.address.slice(0, 6)}...) ha recibido 500 CLAW.`,
  );

  // Revisar saldos iniciales
  const buyerBalanceInit = await contract.balanceOf(buyerAgent.address);
  const sellerBalanceInit = await contract.balanceOf(sellerAgent.address);
  console.log(`   Saldo Inicial Comprador: ${ethers.formatUnits(buyerBalanceInit, 18)} CLAW`);
  console.log(`   Saldo Inicial Vendedor:  ${ethers.formatUnits(sellerBalanceInit, 18)} CLAW`);

  // 4. Iniciar Servicio: El Comprador solicita y bloquea fondos en el Contrato (Escrow)
  console.log("\n🛡️ [FASE 2] El Comprador contrata un servicio y bloquea fondos en Escrow...");
  const servicePrice = ethers.parseUnits("150", 18); // El servicio cuesta 150 CLAW

  // (a) Aprobar al contrato para que mueva los fondos
  const approveTx = await contract.connect(buyerAgent).approve(contractAddress, servicePrice);
  await approveTx.wait();

  const allowance = await contract.allowance(buyerAgent.address, contractAddress);
  console.log(
    `✅ Comprador aprueba el gasto de 150 CLAW. Confirmado en on-chain allowance: ${ethers.formatUnits(allowance, 18)}`,
  );

  // (b) Crear el Escrow en la blockchain
  const tradeHash = ethers.keccak256(ethers.toUtf8Bytes("trade_simulated_id_A_to_B"));
  await contract.connect(buyerAgent).createEscrow(sellerAgent.address, servicePrice, tradeHash);
  console.log(`🔒 150 CLAW han sido bloqueados de forma segura en el Smart Contract!`);

  // Revisar saldos intermedios
  const buyerBalanceMid = await contract.balanceOf(buyerAgent.address);
  console.log(`   Saldo Intermedio Comprador: ${ethers.formatUnits(buyerBalanceMid, 18)} CLAW`);

  // 5. Simular la entrega del servicio por parte del agente
  console.log(
    "\n💻 [FASE 3] El Agente Vendedor está procesando y entregando el código/datos al Comprador...",
  );
  await new Promise((resolve) => setTimeout(resolve, 2000));
  console.log(`✅ ¡Servicio entregado con éxito!`);

  // 6. Finalización: El comprador revisa el trabajo y libera los fondos al vendedor
  console.log("\n🔓 [FASE 4] El Comprador inspecciona el trabajo y libera los fondos...");
  await contract.connect(buyerAgent).releaseEscrow(tradeHash);
  console.log(`✅ ¡Fondos liberados automáticamente al Agente Vendedor!`);

  // Revisar saldos Finales
  console.log("\n📊 [RESUMEN FINAL]");
  const buyerBalanceFinal = await contract.balanceOf(buyerAgent.address);
  const sellerBalanceFinal = await contract.balanceOf(sellerAgent.address);

  console.log(`   Saldo Final Comprador: ${ethers.formatUnits(buyerBalanceFinal, 18)} CLAW`);
  console.log(`   Saldo Final Vendedor:  ${ethers.formatUnits(sellerBalanceFinal, 18)} CLAW`);

  console.log(
    "\n🎉 ¡Flujo de Comercio entre Agentes (Escrow) de Moltbot ejecutado a la perfección!",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
