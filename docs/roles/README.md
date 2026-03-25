# ROLES 线程文档

这里存放 `Javis Team / ROLES` 线程的角色重构说明，目标是把角色体系从“重工具耦合”调整为“轻策略编排”。

当前文档：

- `docs/roles/ROLES-thread-plan.md`：本线程执行计划
- `docs/roles/current-role-audit.md`：现有角色问题盘点
- `docs/roles/engineering-role-map.md`：工程角色草案与协作边界
- `docs/roles/role-fabric-matrix.md`：角色与 Fabric 依赖矩阵

本轮不做：

- 不实现 provider 或执行器
- 不把角色重新绑定到底层 CLI
- 不把所有职责揉成万能代理
