@echo off
:: ado-query.bat
:: Lists all active ADO work items assigned to Dumitru Chitoraga.
:: Excludes Done, Resolved, Closed, Removed states.
az boards query ^
  --wiql "SELECT [System.Id], [System.Title], [System.State], [System.WorkItemType], [Microsoft.VSTS.Common.Priority], [System.AreaPath] FROM WorkItems WHERE [System.AssignedTo] = 'Dumitru Chitoraga' AND [System.State] NOT IN ('Done', 'Resolved', 'Closed', 'Removed') ORDER BY [Microsoft.VSTS.Common.Priority] ASC, [System.ChangedDate] DESC" ^
  --org https://dev.azure.com/msazure ^
  --project One ^
  -o json
